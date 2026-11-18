/*
 * YouTube Music for Tesla Theater.
 *
 * Playback: the official YouTube IFrame Player (inside this page, no other app needed).
 * Library: the YouTube Data API (your playlists, liked videos, search), after a Google login
 * (OAuth implicit flow, no secret; only a Client ID created by the user on Google Cloud).
 * The queue, shuffle, repeat, previous / next are handled here, so they behave the same for
 * playlists, liked music, search results and the recently played list.
 */
(function () {
  'use strict';

  const KEY = 'TeslaTheaterYtm';
  const AUTH_KEY = 'TeslaTheaterYtmAuth';
  const RECENT_KEY = 'TeslaTheaterYtmRecent';
  const LAYOUT_KEY = 'TeslaTheaterMusicLayout';
  const SCOPE = 'https://www.googleapis.com/auth/youtube';   // read + manage playlists
  const API = 'https://www.googleapis.com/youtube/v3';
  const LAYOUTS = ['vinyl', 'immersive', 'cinema'];
  // The OAuth client ID is public by design (it is in every web app that uses Google login).
  // Only the accounts listed as test users in the Google Cloud project can sign in with it.
  const DEFAULT_CLIENT_ID = '670805026293-uufnfv1jdbdqp3ipkokl9p0te2dujdff.apps.googleusercontent.com';
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  const st = { clientId: '', access: '', expires: 0 };
  let ytp = null;            // YT.Player
  let ytPromise = null;
  let ready = false;
  let queue = [];            // tracks of the current list: {id, title, artist, thumb}
  let order = [];            // play order: indices into queue
  let pos = -1;              // position inside `order`
  let cur = null;
  let queueName = '';        // where the queue comes from (playlist, liked, search...)
  let muted = false;
  let playing = false;
  let shuffle = false;
  let repeat = 'off';        // off | all | one
  let timeNow = 0;
  let dur = 0;
  let seeking = false;
  let skips = 0;
  let tab = 'playlists';
  let crumb = null;          // open playlist {id, title, tracks}
  let layout = 'vinyl';
  let listToken = 0;
  let shelfLoaded = false;
  let bound = false;
  let open = false;
  let showVideo = false;
  let tickTimer = null;
  const cache = {};

  const byId = id => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) {
      e.className = cls;
    }
    if (text != null) {
      e.textContent = text;
    }
    return e;
  }

  function load() {
    try {
      Object.assign(st, JSON.parse(window.localStorage.getItem(KEY) || '{}'));
    } catch (e) { /* ignore */ }
    if (!st.clientId && !st.ownId) {
      st.clientId = DEFAULT_CLIENT_ID;
    }
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(st));
    } catch (e) { /* ignore */ }
  }

  function redirectUri() {
    return window.location.origin + window.location.pathname.replace(/index\.html$/, '');
  }

  function fmt(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function decode(s) {
    const t = document.createElement('textarea');
    t.innerHTML = s || '';
    return t.value;
  }

  function cleanArtist(s) {
    return decode(s).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  }

  function thumbOf(snippet) {
    const t = (snippet && snippet.thumbnails) || {};
    return (t.medium || t.high || t.default || {}).url || '';
  }

  function setMsg(text, isError) {
    const m = byId('sp-msg');
    m.textContent = text || '';
    m.classList.toggle('hidden', !text);
    m.classList.toggle('error', !!isError);
  }

  // ---------- Google login (implicit flow, redirect) ----------

  function rand(bytes) {
    const a = new Uint8Array(bytes);
    window.crypto.getRandomValues(a);
    return Array.from(a, b => ('0' + b.toString(16)).slice(-2)).join('');
  }

  function authUrl(state, prompt) {
    const p = new URLSearchParams({
      client_id: st.clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      state,
      include_granted_scopes: 'true'
    });
    if (prompt) {
      p.set('prompt', prompt);
    }
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
  }

  function login() {
    const state = rand(12);
    try {
      window.localStorage.setItem(AUTH_KEY, JSON.stringify({ state }));
    } catch (e) { /* ignore */ }
    window.location.href = authUrl(state, '');
  }

  function takeToken(hash, state) {
    const p = new URLSearchParams(hash.replace(/^#/, ''));
    if (!p.get('access_token') || p.get('state') !== state) {
      return false;
    }
    st.access = p.get('access_token');
    st.expires = Date.now() + (Number(p.get('expires_in')) || 3600) * 1000;
    // true only when Google actually granted the permission to change playlists
    st.write = (p.get('scope') || '').split(' ').indexOf(SCOPE) >= 0;
    save();
    return true;
  }

  // Back from the Google login page: the token is in the address fragment.
  function handleCallback() {
    if (window.top !== window.self) {
      return null; // inside the hidden refresh frame: the parent reads the fragment
    }
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(AUTH_KEY) || 'null');
    } catch (e) { /* ignore */ }
    const hash = window.location.hash || '';
    if (!saved || !/access_token=|error=/.test(hash)) {
      return null;
    }
    try {
      window.localStorage.removeItem(AUTH_KEY);
    } catch (e) { /* ignore */ }
    const ok = takeToken(hash, saved.state);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return ok ? true : { error: 'Accesso con Google non riuscito o annullato.' };
  }

  // The token lasts one hour: renew it in a hidden frame (works if the Google session is still open).
  function silentRefresh() {
    return new Promise((resolve, reject) => {
      const state = rand(12);
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.src = authUrl(state, 'none');
      document.body.appendChild(frame);
      const t0 = Date.now();
      const iv = setInterval(() => {
        let hash = '';
        try {
          hash = frame.contentWindow.location.hash;
        } catch (e) { /* still on the Google page */ }
        if (hash && takeToken(hash, state)) {
          clearInterval(iv);
          frame.remove();
          resolve();
        } else if ((hash && /error=/.test(hash)) || Date.now() - t0 > 9000) {
          clearInterval(iv);
          frame.remove();
          reject(new Error('Sessione Google scaduta.'));
        }
      }, 250);
    });
  }

  function logout() {
    st.access = '';
    st.expires = 0;
    save();
    Object.keys(cache).forEach(k => delete cache[k]);
    crumb = null;
    shelfLoaded = false;
    render();
  }

  async function api(path, params, body) {
    if (!st.access) {
      const e = new Error('Accedi a Google.');
      e.auth = true;
      throw e;
    }
    if (Date.now() > st.expires - 60000) {
      try {
        await silentRefresh();
      } catch (e) {
        e.auth = true;
        throw e;
      }
    }
    const q = new URLSearchParams();
    Object.keys(params || {}).forEach(k => {
      if (params[k] !== '' && params[k] != null) {
        q.set(k, params[k]);
      }
    });
    const opts = { headers: { Authorization: 'Bearer ' + st.access } };
    if (body) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(API + path + '?' + q.toString(), opts);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) {
      st.access = '';
      save();
      const e = new Error('Sessione Google scaduta.');
      e.auth = true;
      throw e;
    }
    if (!r.ok) {
      const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
      e.status = r.status;
      throw e;
    }
    return j;
  }

  function fail(e) {
    if (e && e.auth) {
      setMsg('Accedi di nuovo a Google.', true);
      st.access = '';
      save();
      render();
      return;
    }
    if (e && e.status === 403) {
      setMsg('Google non consente la richiesta: controlla che "YouTube Data API v3" sia attiva e che il tuo account sia tra gli utenti di test. Oppure la quota giornaliera è finita.', true);
      return;
    }
    setMsg((e && e.message) || 'Errore di rete.', true);
  }

  // ---------- YouTube library ----------

  const SKIP_TITLES = ['Private video', 'Deleted video', 'Video privato', 'Video eliminato'];

  // "Artist - Topic" channels carry auto-generated art tracks: the "video" is only the still cover
  function isTopic(raw) {
    return /-\s*Topic$/i.test(decode(raw || '').trim());
  }
  function trackOf(it) {
    const sn = it.snippet || {};
    const id = (it.contentDetails && it.contentDetails.videoId) || (sn.resourceId && sn.resourceId.videoId) || '';
    if (!id || SKIP_TITLES.includes(sn.title)) {
      return null;
    }
    return { id, title: decode(sn.title), artist: cleanArtist(sn.videoOwnerChannelTitle || ''), thumb: thumbOf(sn), topic: isTopic(sn.videoOwnerChannelTitle), channelId: sn.videoOwnerChannelId || '' };
  }

  async function fetchPlaylists() {
    if (cache.playlists) {
      return cache.playlists;
    }
    const out = [];
    let token = '';
    for (let i = 0; i < 4; i++) {
      const d = await api('/playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', pageToken: token });
      (d.items || []).forEach(p => out.push({
        id: p.id,
        title: decode(p.snippet.title),
        thumb: thumbOf(p.snippet),
        count: p.contentDetails ? p.contentDetails.itemCount : null
      }));
      token = d.nextPageToken;
      if (!token) {
        break;
      }
    }
    cache.playlists = out;
    return out;
  }

  // keeps only songs: videos YouTube files under the Music category (liked videos and mixed
  // playlists also hold clips, shows and tutorials that do not belong in a music player)
  async function onlyMusic(tracks) {
    const info = {};
    try {
      for (let k = 0; k < tracks.length; k += 50) {
        const ids = tracks.slice(k, k + 50).map(t => t.id).join(',');
        const d = await api('/videos', { part: 'snippet,status', id: ids, maxResults: '50' });
        (d.items || []).forEach(it => {
          info[it.id] = {
            cat: it.snippet.categoryId,
            // can the video be played in an embedded player at all?
            playable: !(it.status && (it.status.embeddable === false || it.status.privacyStatus === 'private'))
          };
        });
      }
    } catch (e) {
      return tracks;   // if the check fails, show everything rather than nothing
    }
    // non-music videos are dropped; tracks YouTube says cannot be embedded are only marked (dimmed)
    return tracks.filter(t => {
      const i = info[t.id];
      if (!i) {
        return true;
      }
      if (i.cat && i.cat !== '10') {
        return false;
      }
      t.blocked = !i.playable;
      return true;
    });
  }

  async function fetchItems(playlistId) {
    const key = 'items:' + playlistId;
    if (cache[key]) {
      return cache[key];
    }
    const out = [];
    let token = '';
    for (let i = 0; i < 4; i++) {
      const d = await api('/playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: '50', pageToken: token });
      (d.items || []).forEach(it => {
        const t = trackOf(it);
        if (t) {
          out.push(t);
        }
      });
      token = d.nextPageToken;
      if (!token) {
        break;
      }
    }
    const songs = await onlyMusic(out);
    cache[key] = songs;
    return songs;
  }

  async function search(q) {
    // songs (category Music) first, then every other matching video (live, clips, interviews...)
    const base = { part: 'snippet', q, type: 'video', maxResults: '25' };
    const [m, a] = await Promise.all([
      api('/search', { ...base, videoCategoryId: '10' }),
      api('/search', base).catch(() => ({ items: [] }))
    ]);
    const seen = new Set();
    return [...(m.items || []), ...(a.items || [])]
      .filter(it => it.id && it.id.videoId && !seen.has(it.id.videoId) && seen.add(it.id.videoId))
      .map(it => ({
        id: it.id.videoId,
        title: decode(it.snippet.title),
        artist: cleanArtist(it.snippet.channelTitle),
        thumb: thumbOf(it.snippet),
        topic: isTopic(it.snippet.channelTitle),
        channelId: it.snippet.channelId || ''
      }));
  }

  function recents() {
    try {
      return JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function addRecent(t) {
    try {
      const list = [t].concat(recents().filter(x => x.id !== t.id)).slice(0, 40);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (e) { /* ignore */ }
  }

  // ---------- player ----------

  function loadYT() {
    if (window.YT && window.YT.Player) {
      return Promise.resolve();
    }
    if (!ytPromise) {
      ytPromise = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (prev) {
            prev();
          }
          resolve();
        };
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => {
          ytPromise = null;
          reject(new Error('YouTube non raggiungibile.'));
        };
        document.head.appendChild(s);
      });
    }
    return ytPromise;
  }

  async function ensurePlayer() {
    await loadYT();
    if (ytp) {
      return ytp;
    }
    return new Promise(resolve => {
      ytp = new window.YT.Player('ytm-player', {
        width: 320,
        height: 180,
        playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, origin: window.location.origin },
        events: {
          onReady: () => {
            ready = true;
            resolve(ytp);
          },
          onStateChange: onState,
          onError: onError
        }
      });
    });
  }

  function onState(e) {
    const s = e.data;
    if (s === 1) {
      playing = true;
      skips = 0;
    } else if (s === 2) {
      playing = false;
    } else if (s === 0) {
      playing = false;
      ended();
    }
    renderNow();
  }

  // When the owner blocks embedding (error 101/150) the same song is looked up again among videos
  // that are allowed to be embedded (another upload: lyric video, official audio...) and played instead.
  const norm = x => decode(x || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9àèéìòù ]+/g, ' ').split(/\s+/).filter(Boolean);

  function similar(wanted, found) {
    const w = norm(wanted);
    const f = new Set(norm(found));
    return w.length > 0 && w.filter(x => f.has(x)).length / w.length >= 0.6;
  }

  async function findAlternative(t) {
    const d = await api('/search', {
      part: 'snippet',
      q: (t.artist + ' ' + t.title).trim(),
      type: 'video',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      maxResults: '8'
    });
    const hit = (d.items || []).find(it => it.id && it.id.videoId && it.id.videoId !== t.id && similar(t.title, it.snippet.title));
    return hit ? hit.id.videoId : '';
  }

  async function onError(e) {
    // 100 removed, 101/150 embedding disabled by the owner, 2 invalid id, 5 html5 problem
    const code = e && e.data;
    const track = cur;
    if ((code === 101 || code === 150) && track && !track.triedAlt) {
      track.triedAlt = true;
      try {
        const alt = track.altId || await findAlternative(track);
        if (alt && cur === track) {
          track.altId = alt;
          setMsg('Il brano originale non è riproducibile qui: uso un\'altra versione.', false);
          ytp.loadVideoById(alt);
          return;
        }
      } catch (err) { /* fall through to the next song */ }
    }
    skips += 1;
    if (skips > Math.min(5, queue.length)) {
      setMsg('Questi brani non sono riproducibili qui (il proprietario ha disattivato la riproduzione incorporata). Errore ' + code + '.', true);
      playing = false;
      renderNow();
      return;
    }
    setMsg('Brano non riproducibile qui (errore ' + code + '), passo al successivo.', true);
    if (code) {
      next(true);
    }
  }

  function ended() {
    if (repeat === 'one') {
      if (ytp) {
        ytp.seekTo(0, true);
        ytp.playVideo();
      }
      return;
    }
    next(true);
  }

  function rebuildOrder(keepCurrent) {
    const idx = queue.map((t, i) => i);
    const current = keepCurrent && pos >= 0 ? order[pos] : -1;
    if (shuffle) {
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      if (current >= 0) {
        idx.splice(idx.indexOf(current), 1);
        idx.unshift(current);
      }
      order = idx;
      pos = current >= 0 ? 0 : -1;
    } else {
      order = idx;
      pos = current >= 0 ? current : -1;
    }
  }

  async function playPos(p) {
    if (p < 0 || p >= order.length) {
      return;
    }
    pos = p;
    cur = queue[order[pos]];
    timeNow = 0;
    dur = 0;
    renderNow();
    addRecent(cur);
    try {
      const player = await ensurePlayer();
      player.loadVideoById(cur.id);
    } catch (e) {
      fail(e);
    }
  }

  // Starts a list from one of its tracks.
  function playList(tracks, index, label) {
    const list = tracks.filter(Boolean);
    if (!list.length) {
      return;
    }
    queueName = label || '';
    queue = list;
    order = queue.map((t, i) => i);
    pos = Math.min(index || 0, queue.length - 1);
    if (shuffle) {
      rebuildOrder(true);
    }
    setMsg('');
    skips = 0;
    playPos(pos);
  }

  function next(auto) {
    if (!order.length) {
      return;
    }
    if (pos + 1 < order.length) {
      playPos(pos + 1);
    } else if (repeat === 'all' || !auto) {
      if (shuffle) {
        rebuildOrder(false);
      }
      playPos(0);
    } else {
      playing = false;
      renderNow();
    }
  }

  function prev() {
    if (!order.length) {
      return;
    }
    if (timeNow > 3 || pos <= 0) {
      if (ytp) {
        ytp.seekTo(0, true);
      }
    } else {
      playPos(pos - 1);
    }
  }

  function toggle() {
    if (!ytp || !cur) {
      return;
    }
    if (playing) {
      ytp.pauseVideo();
    } else {
      ytp.playVideo();
    }
  }

  function toggleShuffle() {
    shuffle = !shuffle;
    rebuildOrder(true);
    renderNow();
  }

  function cycleRepeat() {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    renderNow();
  }

  // Vinyl: a fine spiral line in the accent colour that grows with the song's progress
  let spiralPath = null;
  let tickAt = 0;
  let spiralRaf = 0;

  function buildSpiral() {
    const host = document.querySelector('.sp-vinyl');
    if (!host || spiralPath) {
      return;
    }
    // a fine, smooth spiral: tight turns that, at the end of the song, cover the whole record from label to edge
    let d = '';
    const n = 2800;
    const turns = 25;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = t * Math.PI * 2 * turns;
      const r = 31 + t * 68;
      d += (i ? 'L' : 'M') + (100 + r * Math.cos(a)).toFixed(2) + ' ' + (100 + r * Math.sin(a)).toFixed(2);
    }
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('class', 'sp-spiral');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('pathLength', '1');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    host.appendChild(svg);
    spiralPath = path;
  }

  // progress of the song, interpolated between the 500 ms player readings
  function updateSpiral() {
    buildSpiral();
    if (!spiralPath) {
      return;
    }
    const est = cur && dur ? timeNow + (playing ? (performance.now() - tickAt) / 1000 : 0) : 0;
    const p = cur && dur ? Math.max(0, Math.min(1, est / dur)) : 0;
    spiralPath.style.strokeDasharray = p.toFixed(5) + ' 1';
  }

  function spiralLoop() {
    spiralRaf = 0;
    if (!open) {
      return;
    }
    updateSpiral();
    spiralRaf = requestAnimationFrame(spiralLoop);
  }

  function startTick() {
    if (tickTimer) {
      return;
    }
    tickTimer = setInterval(() => {
      if (ytp && ready && cur) {
        try {
          timeNow = ytp.getCurrentTime() || 0;
          tickAt = performance.now();
          dur = ytp.getDuration() || dur;
        } catch (e) { /* the player is not ready yet */ }
        if (open && !seeking) {
          byId('sp-seek').value = timeNow;
          byId('sp-pos').textContent = fmt(timeNow);
          byId('sp-dur').textContent = fmt(dur);
          byId('sp-seek').max = dur || 0;
        }
        updateSpiral();
      }
    }, 500);
  }

  function coverUrl(t, size) {
    return t ? 'https://i.ytimg.com/vi/' + t.id + '/' + (size || 'maxresdefault') + '.jpg' : '';
  }

  // ---------- steering-wheel / media keys (Media Session) ----------

  let keepAlive = null;

  // A silent looping sound in the page itself, so the browser treats this page (not the YouTube
  // frame) as the media source and sends the wheel buttons to our handlers.
  function silentAudio() {
    if (keepAlive) {
      return keepAlive;
    }
    try {
      const rate = 8000;
      const n = rate;
      const buf = new ArrayBuffer(44 + n);
      const v = new DataView(buf);
      const w = (o, t) => { for (let i = 0; i < t.length; i++) { v.setUint8(o + i, t.charCodeAt(i)); } };
      w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
      w(36, 'data'); v.setUint32(40, n, true);
      for (let i = 0; i < n; i++) { v.setUint8(44 + i, 128); }
      keepAlive = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
      keepAlive.loop = true;
    } catch (e) {
      keepAlive = null;
    }
    return keepAlive;
  }

  // brief on-screen note when a wheel / media command reaches the page (to see what the car really sends)
  function keyToast(text) {
    let t = byId('media-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'media-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(keyToast.timer);
    keyToast.timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function mediaAction(action) {
    keyToast('Comando: ' + action);
    // a playing / paused YouTube video takes the command, otherwise the music
    if (window.ytCard && window.ytCard.control && window.ytCard.control(action)) {
      return;
    }
    if (action === 'next') {
      next(false);
    } else if (action === 'prev') {
      prev();
    } else if (action === 'play') {
      if (!playing) { toggle(); }
    } else if (action === 'pause') {
      if (playing) { toggle(); }
    } else if (action === 'toggle') {
      toggle();
    }
  }

  window.addEventListener('keydown', e => {
    const map = {
      MediaTrackNext: 'next', MediaTrackPrevious: 'prev', MediaPlayPause: 'toggle', MediaPlay: 'play', MediaPause: 'pause'
    };
    const a = map[e.key];
    if (a) {
      e.preventDefault();
      mediaAction(a);
    }
  });

  // ---------- touch gestures on the cover: swipe = next / previous, double tap = play / pause ----------

  function attachGestures(el, withDoubleTap) {
    if (!el || el.dataset.gestures) {
      return;
    }
    el.dataset.gestures = '1';
    el.style.touchAction = 'pan-y';
    let sx = 0;
    let sy = 0;
    let st0 = 0;
    let lastTap = 0;
    let swiped = false;
    el.addEventListener('pointerdown', e => {
      sx = e.clientX;
      sy = e.clientY;
      st0 = Date.now();
      swiped = false;
    });
    el.addEventListener('pointerup', e => {
      if (!cur) {
        return;
      }
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const dt = Date.now() - st0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
        swiped = true;
        if (dx < 0) {
          keyToast('Successivo');
          next(false);
        } else {
          keyToast('Precedente');
          prev();
        }
        return;
      }
      if (withDoubleTap && Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 450) {
        keyToast(playing ? 'Pausa' : 'Riproduci');
        toggle();
      }
    });
    // a swipe must not also count as a tap (on the home it would open the music page)
    el.addEventListener('click', e => {
      if (swiped) {
        e.stopPropagation();
        e.preventDefault();
        swiped = false;
      }
    }, true);
  }

  function setupGestures() {
    const wrap = byId('sp-cover') && byId('sp-cover').closest('.sp-cover-wrap');
    attachGestures(wrap, true);
    attachGestures(document.querySelector('#dash-now .now-art'), false);
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;
    const set = (a, fn) => {
      try { ms.setActionHandler(a, fn); } catch (e) { /* not supported */ }
    };
    set('play', () => mediaAction('play'));
    set('pause', () => mediaAction('pause'));
    set('previoustrack', () => mediaAction('prev'));
    set('nexttrack', () => mediaAction('next'));
    set('seekto', d => {
      if (ytp && d && typeof d.seekTime === 'number') {
        ytp.seekTo(d.seekTime, true);
      }
    });
  }

  function syncMediaSession() {
    if (!('mediaSession' in navigator)) {
      return;
    }
    if (playing) {
      setupMediaSession();
    }
    const a = silentAudio();
    if (a) {
      if (playing) {
        const pr = a.play();
        if (pr && pr.catch) {
          pr.catch(() => {});
        }
      } else {
        a.pause();
      }
    }
    try {
      if (cur) {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: cur.title || '',
          artist: cur.artist || '',
          artwork: [{ src: coverUrl(cur, 'hqdefault'), sizes: '480x360', type: 'image/jpeg' }]
        });
      }
      navigator.mediaSession.playbackState = playing ? 'playing' : (cur ? 'paused' : 'none');
    } catch (e) { /* ignore */ }
  }

  // ---------- screen: now playing ----------

  function setCover(img, t) {
    if (!t) {
      if (img.getAttribute('src') !== BLANK) {
        img.src = BLANK;
      }
      img.classList.add('empty');
      return;
    }
    const url = coverUrl(t);
    img.classList.remove('empty');
    if (img.dataset.id !== t.id) {
      img.dataset.id = t.id;
      img.onerror = () => {
        img.onerror = null;
        img.src = coverUrl(t, 'hqdefault');
      };
      img.src = url;
    }
  }

  let lastId = null;

  function renderNow() {
    const cover = byId('sp-cover');
    setCover(cover, cur);
    byId('sp-track').textContent = cur ? cur.title : 'Nessuna riproduzione';
    byId('sp-artist').textContent = cur ? cur.artist : 'Scegli un brano dalla libreria.';
    const src = byId('sp-source');
    src.textContent = cur && queueName ? 'In riproduzione da: ' + queueName : '';
    src.classList.toggle('hidden', !(cur && queueName));
    byId('spotify-view').style.setProperty('--sp-cover-url', cur ? 'url("' + coverUrl(cur, 'hqdefault') + '")' : 'none');
    byId('sp-play').innerHTML = '<em class="fas fa-' + (playing ? 'pause' : 'play') + '"></em>';
    byId('sp-play').setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
    byId('spotify-view').classList.toggle('sp-playing', playing);
    syncMediaSession();
    byId('sp-shuffle').classList.toggle('on', shuffle);
    byId('sp-repeat').classList.toggle('on', repeat !== 'off');
    byId('sp-repeat').innerHTML = '<em class="fas fa-retweet"></em>' + (repeat === 'one' ? '<small>1</small>' : '');
    byId('sp-seek').disabled = !cur;
    byId('sp-add').disabled = !cur;
    byId('sp-artist').classList.toggle('link', !!cur);
    byId('sp-seek').max = dur || 0;
    updateSpiral();
    byId('sp-dur').textContent = fmt(dur);
    if (!cur) {
      byId('sp-seek').value = 0;
      byId('sp-pos').textContent = '0:00';
    }
    const id = cur ? cur.id : null;
    if (id !== lastId) {
      lastId = id;
      placeVideo();
      if (layout === 'immersive') {
        applyColor();
      }
    }
    if (layout === 'immersive') {
      renderNav();
    }
  }

  // ---------- looks: Vinile / Immersivo / Cinema ----------

  function setLayout(l, remember) {
    layout = LAYOUTS.includes(l) ? l : 'vinyl';
    const v = byId('spotify-view');
    LAYOUTS.forEach(x => v.classList.toggle('sp-l-' + x, x === layout));
    v.classList.remove('sp-lib-open');
    byId('sp-lib-btn').classList.remove('active');
    byId('sp-lib-btn').classList.toggle('hidden', layout === 'vinyl');
    document.querySelectorAll('.sp-layout').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
    if (remember) {
      try {
        window.localStorage.setItem(LAYOUT_KEY, layout);
      } catch (e) { /* ignore */ }
    }
    if (layout === 'cinema') {
      loadShelf();
    }
    if (layout === 'immersive') {
      lastId = null;
      applyColor();
      renderNav();
    }
    placeVideo();
  }

  // Background colour of the immersive look: the cover's average colour, darkened.
  // Copertina look: background and glow follow the colours of the cover
  function applyColor() {
    const v = byId('spotify-view');
    if (!cur || layout !== 'immersive') {
      v.style.removeProperty('--sp-bg');
      v.style.removeProperty('--sp-glow');
      return;
    }
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 16;
        c.height = 16;
        const x = c.getContext('2d');
        const side = Math.min(probe.naturalWidth, probe.naturalHeight);
        x.drawImage(probe, (probe.naturalWidth - side) / 2, (probe.naturalHeight - side) / 2, side, side, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 4;
        r /= n;
        g /= n;
        b /= n;
        const peak = Math.max(r, g, b) || 1;
        const k = Math.min(0.6, 105 / peak);
        const kg = Math.min(2.2, 210 / peak);
        v.style.setProperty('--sp-bg', 'rgb(' + Math.round(r * k) + ',' + Math.round(g * k) + ',' + Math.round(b * k) + ')');
        v.style.setProperty('--sp-glow', 'rgba(' + Math.min(255, Math.round(r * kg)) + ',' + Math.min(255, Math.round(g * kg)) + ',' + Math.min(255, Math.round(b * kg)) + ',0.55)');
      } catch (e) {
        v.style.removeProperty('--sp-bg');
        v.style.removeProperty('--sp-glow');
      }
    };
    probe.onerror = () => {
      v.style.removeProperty('--sp-bg');
      v.style.removeProperty('--sp-glow');
    };
    probe.src = coverUrl(cur, 'hqdefault');
  }

  function setLayout(l, remember) {
    layout = LAYOUTS.includes(l) ? l : 'vinyl';
    const v = byId('spotify-view');
    LAYOUTS.forEach(x => v.classList.toggle('sp-l-' + x, x === layout));
    v.classList.remove('sp-lib-open');
    byId('sp-lib-btn').classList.remove('active');
    byId('sp-lib-btn').classList.toggle('hidden', layout === 'vinyl');
    document.querySelectorAll('.sp-layout').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
    if (remember) {
      try {
        window.localStorage.setItem(LAYOUT_KEY, layout);
      } catch (e) { /* ignore */ }
    }
    if (layout === 'cinema') {
      loadShelf();
    }
    if (layout === 'immersive') {
      lastId = null;
      applyColor();
      renderNav();
    }
    placeVideo();
  }

  // Background colour of the immersive look: the cover's average colour, darkened.
  // the immersive layout uses the style and accent colours; no colour is taken from the cover any more
  function applyColor() {
    byId('spotify-view').style.removeProperty('--sp-bg');
  }

  function setLayout(l, remember) {
    layout = LAYOUTS.includes(l) ? l : 'vinyl';
    const v = byId('spotify-view');
    LAYOUTS.forEach(x => v.classList.toggle('sp-l-' + x, x === layout));
    v.classList.remove('sp-lib-open');
    byId('sp-lib-btn').classList.remove('active');
    byId('sp-lib-btn').classList.toggle('hidden', layout === 'vinyl');
    document.querySelectorAll('.sp-layout').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
    if (remember) {
      try {
        window.localStorage.setItem(LAYOUT_KEY, layout);
      } catch (e) { /* ignore */ }
    }
    if (layout === 'cinema') {
      loadShelf();
    }
    if (layout === 'immersive') {
      lastId = null;
      applyColor();
      renderNav();
    }
    placeVideo();
  }

  // Background colour of the immersive look: the cover's average colour, darkened.
  function applyColor() {
    const v = byId('spotify-view');
    if (!cur || layout !== 'immersive') {
      v.style.removeProperty('--sp-bg');
      return;
    }
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 16;
        c.height = 16;
        const x = c.getContext('2d');
        // the middle square of the picture (YouTube thumbnails are 16:9)
        const side = Math.min(probe.naturalWidth, probe.naturalHeight);
        x.drawImage(probe, (probe.naturalWidth - side) / 2, (probe.naturalHeight - side) / 2, side, side, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 4;
        r /= n;
        g /= n;
        b /= n;
        const k = Math.min(0.6, 105 / (Math.max(r, g, b) || 1));
        v.style.setProperty('--sp-bg', 'rgb(' + Math.round(r * k) + ',' + Math.round(g * k) + ',' + Math.round(b * k) + ')');
      } catch (e) {
        v.style.removeProperty('--sp-bg');
      }
    };
    probe.onerror = () => v.style.removeProperty('--sp-bg');
    probe.src = coverUrl(cur, 'hqdefault');
  }

  // Previous track on the left, next one on the right (immersive look).
  // one wide card with the next song; the list icon opens the whole queue
  function renderNav() {
    const box = byId('sp-queue');
    if (layout !== 'immersive' || !cur) {
      box.classList.add('hidden');
      return;
    }
    const sig = cur.id + '|' + pos + '|' + order.length + '|' + repeat;
    if (box.dataset.sig === sig && box.children.length) {
      return;
    }
    box.dataset.sig = sig;
    const at = i => (i >= 0 && i < order.length ? queue[order[i]] : null);
    const after = at(pos + 1) || (repeat === 'all' && order.length > 1 ? at(0) : null);
    box.textContent = '';
    if (!after) {
      box.classList.add('hidden');
      return;
    }
    const card = el('button', 'sp-nextcard');
    card.type = 'button';
    card.title = after.title;
    const im = el('img');
    im.alt = '';
    im.src = after.thumb || coverUrl(after, 'mqdefault');
    const tx = el('span', 'sp-nextcard-text');
    tx.appendChild(el('small', null, 'PROSSIMO BRANO'));
    tx.appendChild(el('b', null, after.title));
    tx.appendChild(el('span', null, after.artist));
    const list = el('span', 'sp-nextcard-list');
    list.setAttribute('role', 'button');
    list.setAttribute('aria-label', 'Apri la coda');
    list.innerHTML = '<em class="fas fa-list-ul"></em>';
    list.addEventListener('click', e => {
      e.stopPropagation();
      openQueue();
    });
    card.append(im, tx, list);
    card.addEventListener('click', () => next(false));
    box.appendChild(card);
    box.classList.remove('hidden');
  }

  function openQueue() {
    crumb = { id: 'queue', title: 'In coda', queue: true };
    byId('spotify-view').classList.add('sp-lib-open');
    byId('sp-lib-btn').classList.add('active');
    renderList();
  }

  async function loadShelf() {
    if (shelfLoaded || !st.access) {
      return;
    }
    try {
      const pls = (await fetchPlaylists()).slice(0, 12);
      const box = byId('sp-shelf');
      box.textContent = '';
      box.appendChild(el('div', 'sp-shelf-title', 'Le tue playlist'));
      const row = el('div', 'sp-shelf-row');
      pls.forEach(p => {
        const b = el('button', 'sp-card');
        b.type = 'button';
        const im = el('img');
        im.alt = '';
        im.loading = 'lazy';
        im.src = p.thumb;
        b.appendChild(im);
        b.appendChild(el('span', null, p.title));
        b.addEventListener('click', async () => {
          try {
            playList(await fetchItems(p.id), 0, p.title);
          } catch (e) {
            fail(e);
          }
        });
        row.appendChild(b);
      });
      box.appendChild(row);
      shelfLoaded = true;
    } catch (e) { /* the shelf is optional */ }
  }

  // The real video can be shown over the cover (some music videos are worth it): over the cover
  // of the music page when it is open, over the music tile when the home is on screen.
  function coverTarget() {
    if (open) {
      return byId('sp-cover');
    }
    const home = byId('dash');
    return home && home.offsetParent !== null ? byId('dash-cover') : null;
  }

  function placeVideo() {
    const host = byId('ytm-host');
    if (!host) {
      return;
    }
    const target = coverTarget();
    const f = host.querySelector('iframe');
    // the video sits above the whole page: it steps aside while a panel (style, add app) is open
    const panelOpen = !!document.querySelector('#dash-settings:not(.hidden), #add-app-form:not(.hidden)');
    const realVideo = !!cur && !cur.topic;
    if (showVideo && realVideo && target && !panelOpen) {
      const r = target.getBoundingClientRect();
      host.style.cssText = 'position:fixed;z-index:60;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border-radius:14px;overflow:hidden;';
      if (f) {
        f.style.width = '100%';
        f.style.height = '100%';
      }
    } else {
      host.style.cssText = 'position:fixed;left:-3000px;top:0;width:320px;height:180px;';
      if (f) {
        f.style.width = '320px';
        f.style.height = '180px';
      }
    }
    byId('sp-video-btn').classList.toggle('active', showVideo && realVideo);
    // art tracks have no real video: the button is not offered for them
    byId('sp-video-btn').style.display = cur && cur.topic ? 'none' : '';
    placeCloseButton(showVideo && realVideo && target && !panelOpen ? target.getBoundingClientRect() : null);
  }

  // the video sits above the page, so its own "Video" chip is hidden under it: this button
  // floats above the video and turns it off again
  function placeCloseButton(rect) {
    let b = byId('ytm-close');
    if (!b) {
      b = document.createElement('button');
      b.id = 'ytm-close';
      b.type = 'button';
      b.className = 'ytm-close';
      b.setAttribute('aria-label', 'Chiudi il video');
      b.innerHTML = '<em class="fas fa-times"></em> Chiudi video';
      b.addEventListener('click', e => {
        e.stopPropagation();
        showVideo = false;
        placeVideo();
      });
      document.body.appendChild(b);
    }
    if (!rect || rect.width === 0) {
      b.style.display = 'none';
      return;
    }
    b.style.display = 'inline-flex';
    b.style.left = Math.max(8, rect.right - b.offsetWidth - 10) + 'px';
    b.style.top = (rect.top + 10) + 'px';
  }

  // ---------- library list ----------

  // ---------- add a song to one of your playlists ----------

  function closePicker() {
    const p = byId('sp-picker');
    if (p) {
      p.remove();
    }
  }

  async function addToPlaylist(track, pl) {
    try {
      // already there? one cheap lookup (1 quota unit) avoids a duplicate
      if (!pl.fresh) {
        const has = await api('/playlistItems', { part: 'id', playlistId: pl.id, videoId: track.id, maxResults: '1' });
        if (has.items && has.items.length) {
          closePicker();
          keyToast('Già presente in ' + pl.title);
          return;
        }
      }
      await api('/playlistItems', { part: 'snippet' }, {
        snippet: { playlistId: pl.id, resourceId: { kind: 'youtube#video', videoId: track.id } }
      });
      cache.playlists = null;
      closePicker();
      keyToast('Aggiunto a ' + pl.title);
    } catch (e) {
      if (e.status === 403 || e.auth) {
        // the saved sign-in only allows reading: ask Google for the new permission once
        keyToast('Serve il permesso di modifica: ti riporto a Google…');
        setTimeout(login, 1200);
        return;
      }
      keyToast('Non riesco ad aggiungerlo: ' + (e.message || 'errore'));
    }
  }

  async function openPicker(track) {
    if (!track) {
      return;
    }
    closePicker();
    const wrap = el('div', 'sp-picker');
    wrap.id = 'sp-picker';
    const panel = el('div', 'sp-picker-panel');
    panel.appendChild(el('strong', null, 'Aggiungi a una playlist'));
    panel.appendChild(el('small', null, track.title));
    // new playlist: name it, create it (private) and add the song straight away
    const form = el('form', 'sp-picker-new');
    const nameIn = el('input');
    nameIn.type = 'text';
    nameIn.placeholder = 'Nuova playlist…';
    nameIn.autocomplete = 'off';
    nameIn.setAttribute('aria-label', 'Nome della nuova playlist');
    const mk = el('button', 'actionbutton');
    mk.type = 'submit';
    mk.textContent = 'Crea e aggiungi';
    form.append(nameIn, mk);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) {
        return;
      }
      try {
        const d = await api('/playlists', { part: 'snippet,status' }, {
          snippet: { title: name },
          status: { privacyStatus: 'private' }
        });
        await addToPlaylist(track, { id: d.id, title: name, fresh: true });
      } catch (err) {
        if (err.status === 403 || err.auth) {
          keyToast('Serve il permesso di modifica: ti riporto a Google…');
          setTimeout(login, 1200);
        } else {
          keyToast('Non riesco a creare la playlist: ' + (err.message || 'errore'));
        }
      }
    });
    const list = el('div', 'sp-picker-list');
    list.appendChild(el('p', 'sp-empty', 'Carico…'));
    const close = el('button', 'actionbutton secondary');
    close.type = 'button';
    close.textContent = 'Annulla';
    close.addEventListener('click', closePicker);
    panel.append(form, list, close);
    wrap.appendChild(panel);
    wrap.addEventListener('click', e => {
      if (e.target === wrap) {
        closePicker();
      }
    });
    byId('spotify-view').appendChild(wrap);
    try {
      const pls = await fetchPlaylists();
      list.textContent = '';
      if (!pls.length) {
        list.appendChild(el('p', 'sp-empty', 'Non hai ancora playlist.'));
      }
      pls.forEach(p => {
        const b = el('button', 'sp-picker-item');
        b.type = 'button';
        b.textContent = p.title + (p.count != null ? ' · ' + p.count : '');
        b.addEventListener('click', () => addToPlaylist(track, p));
        list.appendChild(b);
      });
    } catch (e) {
      list.textContent = '';
      list.appendChild(el('p', 'sp-empty', 'Impossibile leggere le playlist.'));
      if (e.auth) {
        fail(e);
      }
    }
  }

  function row(img, title, sub, onClick) {
    const b = el('button', 'sp-row');
    b.type = 'button';
    const im = el('img');
    im.alt = '';
    im.loading = 'lazy';
    if (img) {
      im.src = img;
    }
    b.appendChild(im);
    const t = el('span', 'sp-row-text');
    t.appendChild(el('strong', null, title));
    t.appendChild(el('small', null, sub));
    b.appendChild(t);
    b.addEventListener('click', onClick);
    return b;
  }

  // name shown as "In riproduzione da": the open playlist / artist, or the library tab
  function ctxLabel() {
    if (crumb) {
      return crumb.queue ? queueName : crumb.title;
    }
    return { liked: 'Piaciuti', recent: 'Recenti', search: 'Risultati di ricerca' }[tab] || '';
  }

  function trackRows(tracks) {
    const box = byId('sp-list');
    tracks.forEach((t, i) => {
      const r = row(t.thumb, t.title, t.artist, () => playList(tracks, i, ctxLabel()));
      if (t.blocked) {
        r.classList.add('blocked');
        r.title = 'YouTube segnala che questo brano non può essere riprodotto fuori dal suo sito';
      }
      const add = el('span', 'sp-row-add');
      add.setAttribute('role', 'button');
      add.setAttribute('aria-label', 'Aggiungi a una playlist');
      add.title = 'Aggiungi a una playlist';
      add.innerHTML = '<em class="fas fa-plus"></em>';
      add.addEventListener('click', e => {
        e.stopPropagation();
        openPicker(t);
      });
      r.appendChild(add);
      box.appendChild(r);
    });
    if (!tracks.length) {
      box.appendChild(el('p', 'sp-empty', 'Nessun brano da mostrare.'));
    }
  }

  // search from anywhere: opens the library (it is closed in the Immersive and Cinema looks) and lists the results
  async function runSearch(q) {
    if (!q) {
      return;
    }
    tab = 'search';
    crumb = null;
    cache.lastSearch = null;
    byId('sp-search-input').value = q;
    byId('sp-top-q').value = q;
    if (layout !== 'vinyl') {
      byId('spotify-view').classList.add('sp-lib-open');
      byId('sp-lib-btn').classList.add('active');
    }
    await renderList();
    const box = byId('sp-list');
    box.textContent = '';
    box.appendChild(el('p', 'sp-empty', 'Cerco…'));
    try {
      cache.lastSearch = await search(q);
      box.textContent = '';
      trackRows(cache.lastSearch);
    } catch (err) {
      box.textContent = '';
      fail(err);
    }
  }

  // ---------- artist page: albums and songs of the artist's channel ----------

  async function fetchArtist(c) {
    let id = c.channelId;
    if (!id) {
      // older saved tracks carry no channel: look the artist up by name
      const d = await api('/search', { part: 'snippet', q: c.title, type: 'channel', maxResults: '5' });
      const hit = (d.items || []).find(x => /topic/i.test(x.snippet.channelTitle || x.snippet.title || '')) || (d.items || [])[0];
      id = hit ? (hit.id.channelId || (hit.snippet && hit.snippet.channelId)) : '';
    }
    if (!id) {
      throw new Error('Artista non trovato.');
    }
    const ch = await api('/channels', { part: 'contentDetails', id });
    const up = ch.items && ch.items[0] && ch.items[0].contentDetails.relatedPlaylists.uploads;
    const [albums, tracks] = await Promise.all([
      api('/playlists', { part: 'snippet,contentDetails', channelId: id, maxResults: '50' }).catch(() => ({ items: [] })),
      up ? fetchItems(up) : Promise.resolve([])
    ]);
    return {
      albums: (albums.items || []).map(p => ({
        id: p.id, title: decode(p.snippet.title), thumb: thumbOf(p.snippet),
        count: p.contentDetails ? p.contentDetails.itemCount : null
      })),
      tracks
    };
  }

  function openArtist(track) {
    if (!track || !track.artist) {
      return;
    }
    crumb = { id: 'artist', title: track.artist, channelId: track.channelId || '', artist: true };
    if (layout !== 'vinyl') {
      byId('spotify-view').classList.add('sp-lib-open');
      byId('sp-lib-btn').classList.add('active');
    }
    renderList();
  }

  async function renderList() {
    const token = ++listToken;
    const box = byId('sp-list');
    box.textContent = '';
    document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    byId('sp-crumb').classList.toggle('hidden', !crumb);
    byId('sp-tabs').classList.toggle('hidden', !!crumb);
    byId('sp-search-form').classList.toggle('hidden', !!crumb || tab !== 'search');
    if (tab === 'search' && !crumb) {
      if (cache.lastSearch) {
        trackRows(cache.lastSearch);
      } else {
        box.appendChild(el('p', 'sp-empty', 'Usa la barra di ricerca in alto per cercare brani, artisti e video.'));
      }
      return;
    }
    box.appendChild(el('p', 'sp-empty', 'Carico…'));
    try {
      let build;
      if (crumb) {
        byId('sp-crumb-name').textContent = crumb.title;
        if (crumb.queue) {
          crumb.tracks = null;
          build = () => {
            order.forEach((qi, k) => {
              const t = queue[qi];
              const r = row(t.thumb, t.title, t.artist, () => playPos(k));
              if (k === pos) {
                r.classList.add('playing');
              }
              box.appendChild(r);
            });
            if (!order.length) {
              box.appendChild(el('p', 'sp-empty', 'La coda è vuota.'));
            }
          };
        } else if (crumb.artist) {
          const page = await fetchArtist(crumb);
          crumb.tracks = page.tracks;
          build = () => {
            page.albums.forEach(p => {
              box.appendChild(row(p.thumb, p.title, 'Album' + (p.count != null ? ' · ' + p.count + ' brani' : ''),
                () => { crumb = { id: p.id, title: p.title }; renderList(); }));
            });
            trackRows(page.tracks);
          };
        } else {
          const tracks = await fetchItems(crumb.id);
          crumb.tracks = tracks;
          build = () => trackRows(tracks);
        }
      } else if (tab === 'playlists') {
        const pls = await fetchPlaylists();
        build = () => pls.forEach(p => {
          const r = row(p.thumb, p.title, (p.count != null ? p.count + ' brani' : 'Playlist'),
            () => { crumb = { id: p.id, title: p.title }; renderList(); });
          const play = el('span', 'sp-row-play');
          play.setAttribute('role', 'button');
          play.setAttribute('aria-label', 'Riproduci la playlist');
          play.title = 'Riproduci';
          play.innerHTML = '<em class="fas fa-play"></em>';
          play.addEventListener('click', async e => {
            e.stopPropagation();
            try {
              playList(await fetchItems(p.id), 0, p.title);
            } catch (err) {
              fail(err);
            }
          });
          r.appendChild(play);
          box.appendChild(r);
        });
        if (!pls.length) {
          build = () => box.appendChild(el('p', 'sp-empty', 'Non hai ancora playlist.'));
        }
      } else if (tab === 'liked') {
        const tracks = await fetchItems('LL');
        build = () => trackRows(tracks);
      } else {
        const tracks = recents();
        build = () => trackRows(tracks);
      }
      if (token !== listToken) {
        return;
      }
      box.textContent = '';
      build();
    } catch (e) {
      if (token !== listToken) {
        return;
      }
      box.textContent = '';
      box.appendChild(el('p', 'sp-empty', crumb ? 'Impossibile leggere questa playlist.' : 'Impossibile caricare l\'elenco: ' + e.message));
      if (e.auth) {
        fail(e);
      }
    }
  }

  // ---------- screens ----------

  function render() {
    const setup = byId('sp-setup');
    const main = byId('sp-main');
    const loggedIn = !!st.access;
    byId('sp-logout').classList.toggle('hidden', !loggedIn);
    byId('sp-video-btn').classList.toggle('hidden', !loggedIn);
    byId('sp-top-search').classList.toggle('hidden', !loggedIn);
    main.classList.toggle('hidden', !loggedIn);
    setup.classList.toggle('hidden', loggedIn);
    if (loggedIn) {
      renderList();
      renderNow();
      if (layout === 'cinema') {
        loadShelf();
      }
      return;
    }
    byId('sp-redirect').textContent = redirectUri();
    byId('sp-origin').textContent = window.location.origin;
    const hasId = !!st.clientId;
    byId('sp-step-id').classList.toggle('hidden', hasId);
    byId('sp-step-login').classList.toggle('hidden', !hasId);
    byId('sp-client-id').value = st.clientId;
  }

  function bind() {
    if (bound) {
      return;
    }
    bound = true;
    byId('sp-home').addEventListener('click', closeMusic);
    byId('sp-logout').addEventListener('click', () => {
      closePicker();
      const wrap = el('div', 'sp-picker');
      wrap.id = 'sp-picker';
      const panel = el('div', 'sp-picker-panel');
      panel.appendChild(el('strong', null, 'Disconnettere l\'account Google?'));
      panel.appendChild(el('small', null, 'Dovrai accedere di nuovo per vedere le tue playlist.'));
      const row2 = el('div', 'sp-confirm-row');
      const no = el('button', 'actionbutton secondary');
      no.type = 'button';
      no.textContent = 'Annulla';
      no.addEventListener('click', closePicker);
      const yes = el('button', 'actionbutton');
      yes.type = 'button';
      yes.textContent = 'Disconnetti';
      yes.addEventListener('click', () => {
        closePicker();
        logout();
      });
      row2.append(no, yes);
      panel.appendChild(row2);
      wrap.appendChild(panel);
      wrap.addEventListener('click', e => {
        if (e.target === wrap) {
          closePicker();
        }
      });
      byId('spotify-view').appendChild(wrap);
    });
    byId('sp-video-btn').addEventListener('click', () => {
      showVideo = !showVideo;
      placeVideo();
    });
    document.querySelectorAll('.sp-layout').forEach(b => {
      b.addEventListener('click', () => setLayout(b.dataset.layout, true));
    });
    byId('sp-lib-btn').addEventListener('click', () => {
      const v = byId('spotify-view');
      v.classList.toggle('sp-lib-open', !v.classList.contains('sp-lib-open'));
      byId('sp-lib-btn').classList.toggle('active', v.classList.contains('sp-lib-open'));
    });
    byId('sp-save-id').addEventListener('click', () => {
      const id = byId('sp-client-id').value.trim();
      if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(id)) {
        setMsg('L\'ID client finisce con ".apps.googleusercontent.com". Copialo dalla pagina Credenziali di Google Cloud.', true);
        return;
      }
      setMsg('');
      st.clientId = id;
      st.ownId = id !== DEFAULT_CLIENT_ID;
      save();
      render();
    });
    byId('sp-change-id').addEventListener('click', () => {
      st.clientId = '';
      st.ownId = true;
      save();
      render();
    });
    byId('sp-login-btn').addEventListener('click', login);
    byId('sp-play').addEventListener('click', toggle);
    byId('sp-next').addEventListener('click', () => next(false));
    byId('sp-prev').addEventListener('click', prev);
    byId('sp-shuffle').addEventListener('click', toggleShuffle);
    byId('sp-repeat').addEventListener('click', cycleRepeat);
    byId('sp-add').addEventListener('click', () => openPicker(cur));
    setupGestures();
    byId('sp-artist').addEventListener('click', () => { if (cur) { openArtist(cur); } });
    const seek = byId('sp-seek');
    seek.addEventListener('input', () => {
      seeking = true;
      byId('sp-pos').textContent = fmt(Number(seek.value));
    });
    seek.addEventListener('change', () => {
      if (ytp) {
        ytp.seekTo(Number(seek.value), true);
      }
      timeNow = Number(seek.value);
      seeking = false;
    });
    byId('sp-mute').addEventListener('click', () => {
      muted = !muted;
      if (ytp && ready) {
        if (muted) {
          ytp.mute();
        } else {
          ytp.unMute();
        }
      }
      byId('sp-mute').firstElementChild.className = 'fas fa-volume-' + (muted ? 'mute' : 'up');
    });
    byId('sp-vol').addEventListener('input', e => {
      if (muted) {
        muted = false;
        if (ytp && ready) {
          ytp.unMute();
        }
        byId('sp-mute').firstElementChild.className = 'fas fa-volume-up';
      }
      if (ytp && ready) {
        ytp.setVolume(Number(e.target.value));
      }
    });
    document.querySelectorAll('.sp-tab').forEach(b => {
      b.addEventListener('click', () => {
        tab = b.dataset.tab;
        crumb = null;
        renderList();
      });
    });
    byId('sp-back').addEventListener('click', () => {
      crumb = null;
      renderList();
    });
    byId('sp-crumb-play').addEventListener('click', () => {
      if (crumb && crumb.tracks) {
        playList(crumb.tracks, 0, crumb.title);
      }
    });
    byId('sp-search-form').addEventListener('submit', e => {
      e.preventDefault();
      runSearch(byId('sp-search-input').value.trim());
    });
    byId('sp-top-search').addEventListener('submit', e => {
      e.preventDefault();
      runSearch(byId('sp-top-q').value.trim());
    });
    window.addEventListener('resize', () => setTimeout(placeVideo, 150));
  }

  function openMusic() {
    if (window.ytCard) {
      window.ytCard.pause();
    }
    bind();
    load();
    open = true;
    try {
      setLayout(window.localStorage.getItem(LAYOUT_KEY) || 'vinyl', false);
    } catch (e) {
      setLayout('vinyl', false);
    }
    $('#app-header, #add-app-form').addClass('hidden');
    byId('iptv-view').classList.add('hidden');
    byId('app-root').classList.remove('hidden');
    byId('spotify-view').classList.remove('hidden');
    document.body.classList.add('spotify-open');
    setMsg('');
    render();
    updateSpiral();
    if (!spiralRaf) {
      spiralRaf = requestAnimationFrame(spiralLoop);
    }
    startTick();
    setTimeout(placeVideo, 100);
  }

  function closeMusic() {
    open = false;
    byId('spotify-view').classList.add('hidden');
    document.body.classList.remove('spotify-open');
    $('#app-header').removeClass('hidden');
    placeVideo();
    if (typeof resizeTiles === 'function') {
      resizeTiles();
    }
  }

  function reset() {
    try {
      window.localStorage.removeItem(KEY);
      window.localStorage.removeItem(AUTH_KEY);
      window.localStorage.removeItem(RECENT_KEY);
      window.localStorage.removeItem(LAYOUT_KEY);
    } catch (e) { /* ignore */ }
    st.clientId = DEFAULT_CLIENT_ID;
    st.ownId = false;
    st.access = '';
    st.expires = 0;
  }

  setupMediaSession();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupGestures);
  } else {
    setupGestures();
  }

  // What the home dashboard needs.
  window.musicApi = {
    state: () => ({
      has: !!cur,
      title: cur ? cur.title : '',
      artist: cur ? cur.artist : '',
      cover: cur ? coverUrl(cur) : '',
      coverId: cur ? cur.id : '',
      playing,
      progress: timeNow,
      duration: dur,
      shuffle,
      repeat,
      video: showVideo && !!cur && !cur.topic,
      hasVideo: !!cur && !cur.topic
    }),
    toggle,
    next: () => next(false),
    prev,
    shuffle: toggleShuffle,
    repeat: cycleRepeat,
    open: () => openMusic(),
    playlists: () => fetchPlaylists(),
    playPlaylist: async (id, title) => {
      const tracks = await fetchItems(id);
      if (tracks.length) {
        playList(tracks, 0, title);
      }
    },
    close: () => closeMusic(),
    openArtist: t => { openMusic(); openArtist(t || cur); },
    keepAlive: on => {
      const a = silentAudio();
      if (a) {
        if (on) {
          const pr = a.play();
          if (pr && pr.catch) {
            pr.catch(() => {});
          }
        } else {
          a.pause();
        }
      }
    },
    // shared Google session, used by the YouTube video view
    init: load,
    call: api,
    loggedIn: () => !!st.access,
    login,
    toggleVideo: () => {
      showVideo = !showVideo;
      placeVideo();
    },
    place: placeVideo
  };
  window.openMusic = openMusic;
  window.musicReset = reset;

  // Back from the Google login page: finish the login and open the player.
  document.addEventListener('DOMContentLoaded', () => {
    load();
    startTick();
    // the hidden player host (always present, so playback goes on with the page closed)
    const host = el('div');
    host.id = 'ytm-host';
    host.style.cssText = 'position:fixed;left:-3000px;top:0;width:320px;height:180px;';
    const target = el('div');
    target.id = 'ytm-player';
    host.appendChild(target);
    document.body.appendChild(host);
    const result = handleCallback();
    if (result === null) {
      return;
    }
    openMusic();
    if (result !== true) {
      setMsg(result.error, true);
    }
  });
}());
