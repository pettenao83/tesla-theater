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
  const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
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

  async function api(path, params) {
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
    const r = await fetch(API + path + '?' + q.toString(), { headers: { Authorization: 'Bearer ' + st.access } });
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

  function trackOf(it) {
    const sn = it.snippet || {};
    const id = (it.contentDetails && it.contentDetails.videoId) || (sn.resourceId && sn.resourceId.videoId) || '';
    if (!id || SKIP_TITLES.includes(sn.title)) {
      return null;
    }
    return { id, title: decode(sn.title), artist: cleanArtist(sn.videoOwnerChannelTitle || ''), thumb: thumbOf(sn) };
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
    cache[key] = out;
    return out;
  }

  async function search(q) {
    const d = await api('/search', { part: 'snippet', q, type: 'video', videoCategoryId: '10', maxResults: '25' });
    return (d.items || []).filter(it => it.id && it.id.videoId).map(it => ({
      id: it.id.videoId,
      title: decode(it.snippet.title),
      artist: cleanArtist(it.snippet.channelTitle),
      thumb: thumbOf(it.snippet)
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

  function onError(e) {
    // 100 removed, 101/150 embedding disabled by the owner, 2 invalid id, 5 html5 problem
    skips += 1;
    if (skips > Math.min(5, queue.length)) {
      setMsg('Questi brani non sono riproducibili qui (il proprietario ha disattivato la riproduzione incorporata).', true);
      playing = false;
      renderNow();
      return;
    }
    setMsg('Brano non riproducibile qui, passo al successivo.', true);
    if (e && e.data) {
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
  function playList(tracks, index) {
    const list = tracks.filter(Boolean);
    if (!list.length) {
      return;
    }
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

  // Vinyl: a zig-zag spiral in the accent colour that grows with the song's progress
  let spiralPath = null;
  let spiralTip = null;
  let spiralLen = 0;
  let tickAt = 0;
  let spiralRaf = 0;

  function buildSpiral() {
    const host = document.querySelector('.sp-vinyl');
    if (!host || spiralPath) {
      return;
    }
    let d = '';
    const n = 180;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = t * Math.PI * 2 * 4;
      const r = 34 + t * 58 + (i % 2 ? 4.2 : -4.2);
      d += (i ? 'L' : 'M') + (100 + r * Math.cos(a)).toFixed(1) + ' ' + (100 + r * Math.sin(a)).toFixed(1);
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
    const tip = document.createElementNS(ns, 'circle');
    tip.setAttribute('class', 'sp-tip');
    tip.setAttribute('r', '5');
    svg.appendChild(tip);
    host.appendChild(svg);
    spiralPath = path;
    spiralTip = tip;
    spiralLen = path.getTotalLength();
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
    if (spiralLen && spiralTip) {
      const pt = spiralPath.getPointAtLength(p * spiralLen);
      spiralTip.setAttribute('cx', pt.x.toFixed(2));
      spiralTip.setAttribute('cy', pt.y.toFixed(2));
      spiralTip.style.opacity = cur ? '1' : '0';
    }
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
    byId('sp-play').innerHTML = '<em class="fas fa-' + (playing ? 'pause' : 'play') + '"></em>';
    byId('sp-play').setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
    byId('spotify-view').classList.toggle('sp-playing', playing);
    byId('sp-shuffle').classList.toggle('on', shuffle);
    byId('sp-repeat').classList.toggle('on', repeat !== 'off');
    byId('sp-repeat').innerHTML = '<em class="fas fa-retweet"></em>' + (repeat === 'one' ? '<small>1</small>' : '');
    byId('sp-seek').disabled = !cur;
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
    byId('sp-lib-btn').classList.toggle('hidden', layout !== 'immersive');
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
    const before = at(pos - 1) || (repeat === 'all' && order.length > 1 ? at(order.length - 1) : null);
    const after = at(pos + 1) || (repeat === 'all' && order.length > 1 ? at(0) : null);
    box.textContent = '';
    if (!before && !after) {
      box.classList.add('hidden');
      return;
    }
    const side = (t, dir, onPick) => {
      const b = el('button', 'sp-nav-btn sp-nav-' + dir);
      b.type = 'button';
      b.title = t.title;
      const arrow = el('em', 'fas fa-chevron-' + (dir === 'prev' ? 'left' : 'right'));
      const im = el('img');
      im.alt = '';
      im.src = t.thumb || coverUrl(t, 'mqdefault');
      const tx = el('span', 'sp-nav-text');
      tx.appendChild(el('b', null, t.title));
      tx.appendChild(el('small', null, t.artist));
      (dir === 'prev' ? [arrow, im, tx] : [tx, im, arrow]).forEach(n => b.appendChild(n));
      b.addEventListener('click', onPick);
      return b;
    };
    const bar = el('div', 'sp-nav-bar');
    bar.appendChild(before ? side(before, 'prev', () => playPos(order.indexOf(queue.indexOf(before)))) : el('span', 'sp-nav-btn sp-nav-empty'));
    bar.appendChild(el('i', 'sp-nav-div'));
    bar.appendChild(after ? side(after, 'next', () => playPos(order.indexOf(queue.indexOf(after)))) : el('span', 'sp-nav-btn sp-nav-empty'));
    box.appendChild(bar);
    box.classList.remove('hidden');
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
            playList(await fetchItems(p.id), 0);
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
    if (showVideo && cur && target && !panelOpen) {
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
    byId('sp-video-btn').classList.toggle('active', showVideo);
  }

  // ---------- library list ----------

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

  function trackRows(tracks) {
    const box = byId('sp-list');
    tracks.forEach((t, i) => {
      box.appendChild(row(t.thumb, t.title, t.artist, () => playList(tracks, i)));
    });
    if (!tracks.length) {
      box.appendChild(el('p', 'sp-empty', 'Nessun brano da mostrare.'));
    }
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
        box.appendChild(el('p', 'sp-empty', 'Scrivi il nome di un brano o di un artista.'));
      }
      return;
    }
    box.appendChild(el('p', 'sp-empty', 'Carico…'));
    try {
      let build;
      if (crumb) {
        byId('sp-crumb-name').textContent = crumb.title;
        const tracks = await fetchItems(crumb.id);
        crumb.tracks = tracks;
        build = () => trackRows(tracks);
      } else if (tab === 'playlists') {
        const pls = await fetchPlaylists();
        build = () => pls.forEach(p => {
          box.appendChild(row(p.thumb, p.title, (p.count != null ? p.count + ' brani' : 'Playlist'),
            () => { crumb = { id: p.id, title: p.title }; renderList(); }));
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
    byId('sp-logout').addEventListener('click', logout);
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
    byId('sp-vol').addEventListener('input', e => {
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
        playList(crumb.tracks, 0);
      }
    });
    byId('sp-search-form').addEventListener('submit', async e => {
      e.preventDefault();
      const q = byId('sp-search-input').value.trim();
      if (!q) {
        return;
      }
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
    $('#app-header, #apps, #add-app-form').addClass('hidden');
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
    $('#app-header, #apps').removeClass('hidden');
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
      video: showVideo
    }),
    toggle,
    next: () => next(false),
    prev,
    shuffle: toggleShuffle,
    repeat: cycleRepeat,
    open: () => openMusic(),
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
