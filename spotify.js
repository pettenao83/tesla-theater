/*
 * Spotify remote for Tesla Theater.
 *
 * The page does not play audio itself (the Tesla browser may lack the DRM needed by
 * the Web Playback SDK): it logs in with Spotify (PKCE, no secret needed) and works as
 * a big "now playing" screen + remote control for whatever Spotify device is active
 * (the car's Spotify app, the phone, ...), and browses playlists / liked songs / recents.
 * Spotify Premium is needed to control playback.
 */
(function () {
  'use strict';

  const KEY = 'TeslaTheaterSpotify';
  const AUTH_KEY = 'TeslaTheaterSpotifyAuth';
  const SCOPES = [
    'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
    'playlist-read-private', 'playlist-read-collaborative', 'user-library-read',
    'user-read-recently-played'
  ].join(' ');
  const API = 'https://api.spotify.com/v1';

  const st = { clientId: '', access: '', refresh: '', expires: 0 };
  let player = null;
  let pollTimer = null;
  let tickTimer = null;
  let tab = 'playlists';
  let crumb = null; // open playlist {id, uri, name}
  let bound = false;
  let retryAt = 0;
  let seeking = false;
  let open = false;
  let listToken = 0;

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
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(st));
    } catch (e) { /* ignore */ }
  }

  // The address registered in the Spotify dashboard: the folder of this page.
  function redirectUri() {
    return window.location.origin + window.location.pathname.replace(/index\.html$/, '');
  }

  function fmt(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ---------- login (Authorization Code with PKCE) ----------

  function rand(bytes) {
    const a = new Uint8Array(bytes);
    window.crypto.getRandomValues(a);
    return Array.from(a, b => ('0' + b.toString(16)).slice(-2)).join('');
  }

  async function challengeOf(verifier) {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function login() {
    const verifier = rand(48);
    const state = rand(8);
    try {
      window.localStorage.setItem(AUTH_KEY, JSON.stringify({ verifier, state }));
    } catch (e) { /* ignore */ }
    const params = new URLSearchParams({
      client_id: st.clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: await challengeOf(verifier),
      scope: SCOPES,
      state
    });
    window.location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
  }

  async function tokenRequest(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.error_description || j.error || ('HTTP ' + r.status));
      e.auth = true;
      throw e;
    }
    st.access = j.access_token;
    if (j.refresh_token) {
      st.refresh = j.refresh_token;
    }
    st.expires = Date.now() + (j.expires_in || 3600) * 1000;
    save();
  }

  // Returns null when the URL is not a login answer, true on success, or {error}.
  async function handleCallback() {
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(AUTH_KEY) || 'null');
    } catch (e) { /* ignore */ }
    const p = new URLSearchParams(window.location.search);
    if (!saved || !(p.has('code') || p.has('error'))) {
      return null;
    }
    try {
      window.localStorage.removeItem(AUTH_KEY);
    } catch (e) { /* ignore */ }
    window.history.replaceState(null, '', window.location.pathname);
    if (p.get('error')) {
      return { error: 'Accesso annullato (' + p.get('error') + ').' };
    }
    if (p.get('state') !== saved.state) {
      return { error: 'Risposta di accesso non valida, riprova.' };
    }
    try {
      await tokenRequest({
        grant_type: 'authorization_code',
        code: p.get('code'),
        redirect_uri: redirectUri(),
        client_id: st.clientId,
        code_verifier: saved.verifier
      });
      return true;
    } catch (e) {
      return { error: 'Accesso non riuscito: ' + e.message };
    }
  }

  function logout() {
    st.access = '';
    st.refresh = '';
    st.expires = 0;
    player = null;
    crumb = null;
    save();
    stopTimers();
    render();
  }

  // ---------- Web API ----------

  async function api(path, opt) {
    opt = opt || {};
    if (Date.now() < retryAt) {
      throw new Error('Spotify chiede di rallentare, riprovo tra poco.');
    }
    if (st.refresh && Date.now() > st.expires - 60000) {
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: st.refresh, client_id: st.clientId });
    }
    const headers = { Authorization: 'Bearer ' + st.access };
    if (opt.body) {
      headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(API + path, {
      method: opt.method || 'GET',
      headers,
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
    if (r.status === 401) {
      const e = new Error('Sessione Spotify scaduta.');
      e.auth = true;
      throw e;
    }
    if (r.status === 429) {
      retryAt = Date.now() + (Number(r.headers.get('Retry-After')) || 5) * 1000;
      throw new Error('Spotify chiede di rallentare, riprovo tra poco.');
    }
    if (r.status === 204 || r.status === 202) {
      return null;
    }
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) { /* ignore */ }
    if (!r.ok) {
      const e = new Error((json && json.error && json.error.message) || ('HTTP ' + r.status));
      e.status = r.status;
      e.reason = json && json.error && json.error.reason;
      throw e;
    }
    return json;
  }

  function fail(e) {
    if (e && e.auth) {
      logout();
      setMsg('Accedi di nuovo a Spotify.', true);
      return;
    }
    if (e && e.status === 403) {
      setMsg('Spotify non consente questa azione (serve Premium, oppure non è permessa per questo elemento).', true);
      return;
    }
    if (e && (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE')) {
      setMsg('Nessun dispositivo Spotify attivo: apri Spotify sull\'auto o sul telefono, oppure scegli un dispositivo.', true);
      showDevices();
      return;
    }
    setMsg((e && e.message) || 'Errore di rete.', true);
  }

  function setMsg(text, isError) {
    const m = byId('sp-msg');
    m.textContent = text || '';
    m.classList.toggle('hidden', !text);
    m.classList.toggle('error', !!isError);
  }

  // Sends a playback command, then refreshes the screen shortly after.
  async function command(path, method, body) {
    try {
      await api(path, { method: method || 'PUT', body });
      setMsg('');
    } catch (e) {
      fail(e);
    }
    setTimeout(poll, 350);
  }

  // ---------- now playing ----------

  async function poll() {
    if (!open || !st.access) {
      return;
    }
    try {
      const p = await api('/me/player?additional_types=episode');
      player = p ? Object.assign(p, { _at: Date.now() }) : null;
      renderNow();
    } catch (e) {
      if (e.auth) {
        fail(e);
      } else if (e.status !== 404) {
        setMsg(e.message, true);
      }
    }
  }

  function startTimers() {
    stopTimers();
    poll();
    pollTimer = setInterval(() => {
      if (!document.hidden) {
        poll();
      }
    }, 2500);
    tickTimer = setInterval(tick, 500);
  }

  function stopTimers() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  function currentProgress() {
    if (!player || !player.item) {
      return 0;
    }
    const base = player.progress_ms || 0;
    const extra = player.is_playing ? Date.now() - player._at : 0;
    return Math.min(player.item.duration_ms || 0, base + extra);
  }

  function tick() {
    if (seeking || !player || !player.item) {
      return;
    }
    const pos = currentProgress();
    byId('sp-seek').value = pos;
    byId('sp-pos').textContent = fmt(pos);
  }

  function imageOf(item, small) {
    const imgs = (item && ((item.album && item.album.images) || item.images)) || [];
    if (!imgs.length) {
      return '';
    }
    return (small ? imgs[imgs.length - 1] : imgs[0]).url;
  }

  function artistsOf(item) {
    if (!item) {
      return '';
    }
    if (item.artists) {
      return item.artists.map(a => a.name).join(', ');
    }
    return (item.show && item.show.publisher) || '';
  }

  function renderNow() {
    const item = player && player.item;
    const cover = byId('sp-cover');
    const url = imageOf(item, false);
    cover.classList.toggle('empty', !url);
    if (url) {
      if (cover.getAttribute('src') !== url) {
        cover.src = url;
      }
    } else {
      cover.removeAttribute('src');
    }
    byId('sp-track').textContent = item ? item.name : 'Nessuna riproduzione';
    byId('sp-artist').textContent = item
      ? artistsOf(item)
      : 'Avvia Spotify sull\'auto o sul telefono, oppure scegli un dispositivo.';
    byId('sp-dur').textContent = fmt(item && item.duration_ms);
    const seek = byId('sp-seek');
    seek.max = item ? item.duration_ms : 0;
    seek.disabled = !item;
    byId('sp-device-name').textContent = (player && player.device && player.device.name) || 'Dispositivi';
    const playing = !!(player && player.is_playing);
    byId('sp-play').innerHTML = '<em class="fas fa-' + (playing ? 'pause' : 'play') + '"></em>';
    byId('sp-play').setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
    byId('sp-shuffle').classList.toggle('on', !!(player && player.shuffle_state));
    const repeat = (player && player.repeat_state) || 'off';
    byId('sp-repeat').classList.toggle('on', repeat !== 'off');
    byId('sp-repeat').innerHTML = '<em class="fas fa-repeat"></em>' + (repeat === 'track' ? '<small>1</small>' : '');
    const vol = byId('sp-vol');
    const dev = player && player.device;
    byId('sp-volrow').classList.toggle('hidden', !dev || dev.volume_percent == null || dev.supports_volume === false);
    if (dev && dev.volume_percent != null && document.activeElement !== vol) {
      vol.value = dev.volume_percent;
    }
    tick();
  }

  // ---------- devices ----------

  async function showDevices() {
    const box = byId('sp-devices');
    box.classList.remove('hidden');
    box.textContent = 'Cerco i dispositivi…';
    try {
      const d = await api('/me/player/devices');
      const list = (d && d.devices) || [];
      box.textContent = '';
      box.appendChild(el('strong', null, 'Riproduci su'));
      if (!list.length) {
        box.appendChild(el('p', null, 'Nessun dispositivo trovato. Apri Spotify sull\'auto o sul telefono e riprova.'));
      }
      list.forEach(dev => {
        const b = el('button', 'sp-device' + (dev.is_active ? ' on' : ''), dev.name + ' · ' + dev.type);
        b.type = 'button';
        b.addEventListener('click', async () => {
          box.classList.add('hidden');
          await command('/me/player', 'PUT', { device_ids: [dev.id], play: true });
        });
        box.appendChild(b);
      });
      const close = el('button', 'actionbutton secondary', 'Chiudi');
      close.type = 'button';
      close.addEventListener('click', () => box.classList.add('hidden'));
      box.appendChild(close);
    } catch (e) {
      box.classList.add('hidden');
      fail(e);
    }
  }

  // ---------- library ----------

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

  function trackRows(tracks, contextUri) {
    const box = byId('sp-list');
    const usable = tracks.filter(t => t && t.uri && !t.uri.startsWith('spotify:local'));
    usable.forEach((t, i) => {
      box.appendChild(row(imageOf(t, true), t.name, artistsOf(t), () => {
        if (contextUri) {
          command('/me/player/play', 'PUT', { context_uri: contextUri, offset: { uri: t.uri } });
        } else {
          command('/me/player/play', 'PUT', { uris: usable.slice(i, i + 100).map(x => x.uri) });
        }
      }));
    });
    if (!usable.length) {
      box.appendChild(el('p', 'sp-empty', 'Nessun brano da mostrare.'));
    }
  }

  async function renderList() {
    const token = ++listToken;
    const box = byId('sp-list');
    box.textContent = '';
    box.appendChild(el('p', 'sp-empty', 'Carico…'));
    document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    byId('sp-crumb').classList.toggle('hidden', !crumb);
    byId('sp-tabs').classList.toggle('hidden', !!crumb);
    try {
      let build;
      if (crumb) {
        byId('sp-crumb-name').textContent = crumb.name;
        let d;
        try {
          d = await api('/playlists/' + crumb.id + '/items?limit=100');
        } catch (e) {
          if (e.status === 404 || e.status === 400) {
            d = await api('/playlists/' + crumb.id + '/tracks?limit=100');
          } else {
            throw e;
          }
        }
        build = () => trackRows(((d && d.items) || []).map(x => x.track || x.item || x), crumb.uri);
      } else if (tab === 'playlists') {
        const d = await api('/me/playlists?limit=50');
        build = () => ((d && d.items) || []).filter(Boolean).forEach(p => {
          const total = (p.items && p.items.total) || (p.tracks && p.tracks.total);
          box.appendChild(row(imageOf(p, true), p.name,
            (total != null ? total + ' brani' : 'Playlist') + (p.owner ? ' · ' + (p.owner.display_name || '') : ''),
            () => { crumb = { id: p.id, uri: p.uri, name: p.name }; renderList(); }));
        });
      } else if (tab === 'liked') {
        const d = await api('/me/tracks?limit=50');
        build = () => trackRows(((d && d.items) || []).map(x => x.track), null);
      } else {
        const d = await api('/me/player/recently-played?limit=50');
        const seen = new Set();
        const tracks = ((d && d.items) || []).map(x => x.track).filter(t => t && !seen.has(t.uri) && seen.add(t.uri));
        build = () => trackRows(tracks, null);
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
      box.appendChild(el('p', 'sp-empty', crumb
        ? 'Spotify non permette di leggere i brani di questa playlist da qui. Puoi comunque avviarla con "Riproduci".'
        : 'Impossibile caricare l\'elenco: ' + e.message));
      if (e.auth) {
        fail(e);
      }
    }
  }

  // ---------- screens ----------

  // Shows the right panel: Client ID setup, login, or the player.
  function render() {
    const setup = byId('sp-setup');
    const main = byId('sp-main');
    const loggedIn = !!st.access;
    byId('sp-logout').classList.toggle('hidden', !loggedIn);
    byId('sp-devices-btn').classList.toggle('hidden', !loggedIn);
    main.classList.toggle('hidden', !loggedIn);
    setup.classList.toggle('hidden', loggedIn);
    if (loggedIn) {
      renderList();
      startTimers();
      return;
    }
    byId('sp-redirect').textContent = redirectUri();
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
    byId('sp-home').addEventListener('click', closeSpotify);
    byId('sp-logout').addEventListener('click', logout);
    byId('sp-devices-btn').addEventListener('click', showDevices);
    byId('sp-save-id').addEventListener('click', () => {
      const id = byId('sp-client-id').value.trim();
      if (!/^[0-9a-f]{32}$/i.test(id)) {
        setMsg('Il Client ID è fatto da 32 caratteri (lettere e numeri). Copialo dalla dashboard di Spotify.', true);
        return;
      }
      setMsg('');
      st.clientId = id;
      save();
      render();
    });
    byId('sp-change-id').addEventListener('click', () => {
      st.clientId = '';
      save();
      render();
    });
    byId('sp-login-btn').addEventListener('click', login);
    byId('sp-play').addEventListener('click', () => {
      if (player && player.is_playing) {
        player.is_playing = false;
        renderNow();
        command('/me/player/pause');
      } else {
        if (player) {
          player.is_playing = true;
          player._at = Date.now();
          renderNow();
        }
        command('/me/player/play');
      }
    });
    byId('sp-next').addEventListener('click', () => command('/me/player/next', 'POST'));
    byId('sp-prev').addEventListener('click', () => command('/me/player/previous', 'POST'));
    byId('sp-shuffle').addEventListener('click', () => {
      command('/me/player/shuffle?state=' + !(player && player.shuffle_state));
    });
    byId('sp-repeat').addEventListener('click', () => {
      const order = ['off', 'context', 'track'];
      const next = order[(order.indexOf((player && player.repeat_state) || 'off') + 1) % 3];
      command('/me/player/repeat?state=' + next);
    });
    const seek = byId('sp-seek');
    seek.addEventListener('input', () => {
      seeking = true;
      byId('sp-pos').textContent = fmt(Number(seek.value));
    });
    seek.addEventListener('change', async () => {
      const pos = Math.round(Number(seek.value));
      if (player) {
        player.progress_ms = pos;
        player._at = Date.now();
      }
      await command('/me/player/seek?position_ms=' + pos);
      seeking = false;
    });
    byId('sp-vol').addEventListener('change', e => {
      command('/me/player/volume?volume_percent=' + Math.round(Number(e.target.value)));
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
      if (crumb) {
        command('/me/player/play', 'PUT', { context_uri: crumb.uri });
      }
    });
  }

  function openSpotify() {
    bind();
    load();
    open = true;
    $('#app-header, #apps, #add-app-form').addClass('hidden');
    byId('iptv-view').classList.add('hidden');
    byId('app-root').classList.remove('hidden');
    byId('spotify-view').classList.remove('hidden');
    document.body.classList.add('spotify-open');
    setMsg('');
    render();
  }

  function closeSpotify() {
    open = false;
    stopTimers();
    byId('spotify-view').classList.add('hidden');
    document.body.classList.remove('spotify-open');
    $('#app-header, #apps').removeClass('hidden');
    if (typeof resizeTiles === 'function') {
      resizeTiles();
    }
  }

  function reset() {
    try {
      window.localStorage.removeItem(KEY);
      window.localStorage.removeItem(AUTH_KEY);
    } catch (e) { /* ignore */ }
    st.clientId = '';
    st.access = '';
    st.refresh = '';
    st.expires = 0;
  }

  window.openSpotify = openSpotify;
  window.spotifyReset = reset;
  // Used by the home dashboard for the "now playing" card.
  window.spotifyApi = {
    connected: () => { load(); return !!st.access; },
    call: (path, opt) => api(path, opt)
  };

  // Coming back from the Spotify login page: finish the login and open the player.
  document.addEventListener('DOMContentLoaded', async () => {
    load();
    const result = await handleCallback();
    if (result === null) {
      return;
    }
    openSpotify();
    if (result !== true) {
      setMsg(result.error, true);
    }
  });
}());
