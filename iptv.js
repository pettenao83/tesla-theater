// IPTV client: loads M3U playlists (file or address), lists the channels and
// plays them inside the page (HLS via hls.js, MPEG-TS via mpegts.js, or the
// browser's native <video> for MP4/WebM). Everything stays in the browser:
// playlists are kept in localStorage, nothing is sent to any server of ours.
(function () {
  'use strict';

  const STORAGE_KEY = 'TeslaTheaterIptv';
  const PAGE_SIZE = 200;
  // Address-based lists are downloaded again when the saved copy is older than this.
  const AUTO_REFRESH_MS = 12 * 60 * 60 * 1000;
  // Suggested lists, each offered once per browser (removable). A list added
  // here later also reaches people who already use the IPTV page; one they
  // deleted does not come back, because its id is remembered in `offered`.
  const DEFAULT_LISTS = [
    {
      id: 'default-italia',
      name: 'Italia (funzionanti)',
      url: 'playlists/italia.m3u' // merged and tested list, same origin as the site
    }
  ];
  // Favourites + sort order are shared by everybody: they live in a file of the
  // repository. Edits made in the page are a local draft until saved to that file.
  const PREFS_URL = 'playlists/preferenze.json';
  const PREFS_KEY = 'TeslaTheaterIptvPrefs';
  const FOCUS_KEY = 'TeslaTheaterIptvFocus';
  const AUDIO_KEY = 'TeslaTheaterIptvAudioOnly';
  const SORTS = ['list', 'name', 'group'];
  const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
  const MPEGTS_SRC = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js';
  const DASH_SRC = 'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js';

  let state = { lists: [], activeId: null, offered: [] };
  let pendingUrl = null;  // channel to start as soon as the list is loaded (home shortcut)
  let channels = [];      // channels of the active list: [name, url, logo, group]
  let filtered = [];      // indexes into `channels` matching search + group
  let shown = 0;          // how many of `filtered` are rendered
  let currentIndex = -1;  // index into `channels` of the playing channel
  let playToken = 0;      // invalidates async work of a previous playback
  let hlsPlayer = null;
  let tsPlayer = null;
  let dashPlayer = null;
  let detachVideo = null;
  let bound = false;
  let searchTimer = null;
  let prefs = { sort: 'list', favorites: [] };
  let prefsBase = '';     // fingerprint of the shared file the draft started from
  let prefsDirty = false; // local edits not yet saved to the shared file
  let editMode = false;   // shows the move up/down buttons on favourites
  let favCount = 0;       // how many rows at the top of `filtered` are favourites
  const scripts = {};

  const byId = id => document.getElementById(id);

  // --- Storage -------------------------------------------------------------
  function loadState() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && Array.isArray(raw.lists)) {
        // State saved before `offered` existed had only the first default.
        state = {
          lists: raw.lists,
          activeId: raw.activeId || null,
          offered: Array.isArray(raw.offered) ? raw.offered : ['default-iptvitalia']
        };
        return;
      }
    } catch (e) { /* corrupted value: start clean */ }
    state = { lists: [], activeId: null, offered: [] };
  }

  // Returns 'ok', 'slim' (address-based lists saved without their channels,
  // they are downloaded again on demand) or 'fail' (does not fit at all).
  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return 'ok';
    } catch (e) {
      try {
        const slim = {
          activeId: state.activeId,
          offered: state.offered,
          lists: state.lists.map(l => (l.url ? { id: l.id, name: l.name, url: l.url } : l))
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
        return 'slim';
      } catch (e2) {
        return 'fail';
      }
    }
  }

  function activeList() {
    return state.lists.find(l => l.id === state.activeId) || null;
  }

  // --- M3U parsing ---------------------------------------------------------
  function nameFromUrl(url) {
    const path = url.split(/[?#]/)[0].replace(/\/+$/, '');
    const last = decodeURIComponent(path.split('/').pop() || '').replace(/\.[^.]+$/, '');
    return last || url;
  }

  function parseExtinf(line) {
    let inQuotes = false;
    let comma = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        comma = i;
        break;
      }
    }
    const head = comma === -1 ? line : line.slice(0, comma);
    const title = comma === -1 ? '' : line.slice(comma + 1).trim();
    const attrs = {};
    head.replace(/([\w-]+)="([^"]*)"/g, (_, key, value) => {
      attrs[key.toLowerCase()] = value;
      return '';
    });
    return { title, attrs };
  }

  // True for a single HLS stream (master or media playlist) as opposed to a
  // list of channels. Some channel lists also carry stray #EXT-X-TARGETDURATION
  // lines at the top, so those tags alone prove nothing: a media playlist is
  // told apart by its entries being media segments.
  function isHlsStream(text) {
    if (/#EXT-X-STREAM-INF/.test(text)) {
      return true;
    }
    if (!/#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|ENDLIST)/.test(text)) {
      return false;
    }
    const entries = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const segments = entries.filter(l => /\.(ts|aac|m4s|m4a|m4v|mp4|cmfv|cmfa|vtt|webvtt)([?#]|$)/i.test(l));
    return entries.length > 0 && segments.length / entries.length >= 0.5;
  }

  // Returns the channels, or null when the text is a single HLS stream
  // rather than a list of channels.
  function parseM3u(text) {
    if (isHlsStream(text)) {
      return null;
    }
    const result = [];
    let pending = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith('#EXTINF')) {
        pending = parseExtinf(line);
      } else if (line.startsWith('#EXTGRP:')) {
        if (pending && !pending.attrs['group-title']) {
          pending.attrs['group-title'] = line.slice(8).trim();
        }
      } else if (line.startsWith('#')) {
        continue; // #EXTM3U, #EXTVLCOPT, comments...
      } else {
        const attrs = pending ? pending.attrs : {};
        const name = (pending && pending.title) || attrs['tvg-name'] || nameFromUrl(line);
        result.push([name, line, attrs['tvg-logo'] || '', attrs['group-title'] || '']);
        pending = null;
      }
    }
    return result;
  }

  // --- Playlist sources ----------------------------------------------------
  // github.com/<user>/<repo>/(raw|blob)/<branch>/<file> redirects to
  // raw.githubusercontent.com, but the redirect itself has no usable CORS
  // header and the browser refuses it: point straight at the final address.
  function githubRawUrl(url) {
    const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/i);
    return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3].split('?')[0]}` : url;
  }

  function normalizeUrl(input) {
    const value = input.trim();
    if (/^https?:\/\//i.test(value)) {
      return githubRawUrl(value);
    }
    if (value.startsWith('/') || value.startsWith('./')) {
      return value;
    }
    const first = value.split('/')[0];
    if (value.includes('/') && first.includes('.') && !/\.m3u8?$/i.test(first)) {
      return githubRawUrl('https://' + value);
    }
    return value; // relative to this site, e.g. playlists/mia.m3u
  }

  function listNameFromUrl(url) {
    try {
      const u = new URL(url, window.location.href);
      const base = nameFromUrl(u.pathname);
      return u.origin === window.location.origin ? base : `${base} · ${u.hostname}`;
    } catch (e) {
      return nameFromUrl(url);
    }
  }

  async function fetchPlaylist(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }
    const text = await res.text();
    const parsed = parseM3u(text);
    if (parsed === null) {
      // A single HLS stream: expose it as a one-channel list.
      return [[listNameFromUrl(url), new URL(url, window.location.href).href, '', '']];
    }
    if (!parsed.length) {
      throw new Error('empty');
    }
    return parsed;
  }

  function fetchErrorText(url, err) {
    if (window.location.protocol === 'https:' && /^http:\/\//i.test(url)) {
      return "L'indirizzo è HTTP: il browser lo blocca da una pagina HTTPS. Prova con https:// oppure carica il file della lista.";
    }
    if (err && err.message === 'empty') {
      return 'Nessun canale trovato: controlla che l\'indirizzo punti a una lista M3U.';
    }
    if (err && /^HTTP \d+/.test(err.message)) {
      return `Il server ha risposto ${err.message}. Controlla l'indirizzo.`;
    }
    return 'Impossibile scaricare la lista: indirizzo errato oppure il server non consente l\'accesso da questo sito (CORS). Scarica il file .m3u e usa "Carica file".';
  }

  // --- Status line ---------------------------------------------------------
  function setStatus(text, kind) {
    const el = byId('iptv-status');
    el.textContent = text || '';
    el.classList.toggle('error', kind === 'error');
    el.classList.toggle('warn', kind === 'warn');
    el.classList.toggle('hidden', !text);
  }

  function countStatus() {
    const n = channels.length;
    setStatus(n ? `${n.toLocaleString('it-IT')} canali` : '');
  }

  // --- Rendering -----------------------------------------------------------
  function renderLists() {
    const select = byId('iptv-list-select');
    select.innerHTML = '';
    if (!state.lists.length) {
      select.appendChild(new Option('Nessuna lista', ''));
      select.disabled = true;
    } else {
      select.disabled = false;
      state.lists.forEach(l => {
        const count = l.channels ? ` (${l.channels.length.toLocaleString('it-IT')})` : '';
        select.appendChild(new Option(l.name + count, l.id));
      });
      select.value = state.activeId;
    }
    const active = activeList();
    byId('iptv-refresh').classList.toggle('hidden', !(active && active.url));
    byId('iptv-delete').classList.toggle('hidden', !active);
  }

  function renderGroups() {
    const select = byId('iptv-group');
    const counts = new Map();
    channels.forEach(c => {
      const g = c[3] || 'Senza gruppo';
      counts.set(g, (counts.get(g) || 0) + 1);
    });
    const previous = select.value;
    select.innerHTML = '';
    select.appendChild(new Option(`Tutti i gruppi (${channels.length.toLocaleString('it-IT')})`, ''));
    [...counts.keys()]
      .sort((a, b) => a.localeCompare(b, 'it'))
      .forEach(g => select.appendChild(new Option(`${g} (${counts.get(g).toLocaleString('it-IT')})`, g)));
    select.value = counts.has(previous) ? previous : '';
    select.classList.toggle('hidden', counts.size < 2);
  }

  function placeholderLogo(name) {
    const span = document.createElement('span');
    span.className = 'iptv-logo iptv-logo-ph';
    const initial = name.match(/[\p{L}\p{N}]/u);
    span.textContent = initial ? initial[0].toUpperCase() : '•';
    return span;
  }

  function channelLogo(channel) {
    if (/^https?:\/\//i.test(channel[2])) {
      const img = document.createElement('img');
      img.className = 'iptv-logo';
      img.loading = 'lazy';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.replaceWith(placeholderLogo(channel[0])));
      img.src = channel[2];
      return img;
    }
    return placeholderLogo(channel[0]);
  }

  // Playlist data is untrusted: only ever written with textContent / properties.
  function channelRow(index) {
    const channel = channels[index];
    const item = document.createElement('div');
    item.className = 'iptv-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'iptv-channel';
    button.dataset.index = String(index);
    if (index === currentIndex) {
      button.classList.add('playing');
    }
    const text = document.createElement('span');
    text.className = 'iptv-ch-text';
    const name = document.createElement('span');
    name.className = 'iptv-ch-name';
    name.textContent = channel[0];
    text.appendChild(name);
    if (channel[3]) {
      const group = document.createElement('span');
      group.className = 'iptv-ch-group';
      group.textContent = channel[3];
      text.appendChild(group);
    }
    button.append(channelLogo(channel), text);
    item.appendChild(button);

    const isFav = prefs.favorites.includes(channel[1]);
    if (isFav && editMode) {
      [['up', 'fa-chevron-up', 'Sposta su'], ['down', 'fa-chevron-down', 'Sposta giù']].forEach(([act, icon, label]) => {
        const move = document.createElement('button');
        move.type = 'button';
        move.className = 'iptv-move';
        move.dataset.move = act;
        move.dataset.index = String(index);
        move.title = label;
        move.setAttribute('aria-label', label);
        move.innerHTML = '<em class="fas ' + icon + '"></em>';
        item.appendChild(move);
      });
    }
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'iptv-fav' + (isFav ? ' on' : '');
    star.dataset.index = String(index);
    star.title = isFav ? 'Togli dai preferiti' : 'Aggiungi ai preferiti';
    star.setAttribute('aria-label', star.title);
    star.innerHTML = '<em class="' + (isFav ? 'fas' : 'far') + ' fa-star"></em>';
    item.appendChild(star);
    return item;
  }

  function renderChannelChunk(reset) {
    const box = byId('iptv-channels');
    if (reset) {
      box.textContent = '';
      box.scrollTop = 0;
    } else {
      const more = box.querySelector('.iptv-more');
      if (more) {
        more.remove();
      }
    }
    const end = Math.min(shown + PAGE_SIZE, filtered.length);
    const fragment = document.createDocumentFragment();
    for (let i = shown; i < end; i++) {
      const row = channelRow(filtered[i]);
      if (i < favCount) {
        row.classList.add('is-fav');
        if (i === favCount - 1) {
          row.classList.add('fav-last');
        }
      }
      fragment.appendChild(row);
    }
    shown = end;
    box.appendChild(fragment);

    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'iptv-empty';
      empty.textContent = channels.length
        ? 'Nessun canale corrisponde alla ricerca.'
        : 'Nessuna lista caricata. Usa "Carica file" per aprire un .m3u oppure "Da indirizzo" per scaricarlo da un link.';
      box.appendChild(empty);
    } else if (shown < filtered.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'iptv-more actionbutton secondary';
      more.textContent = `Mostra altri (${(filtered.length - shown).toLocaleString('it-IT')})`;
      box.appendChild(more);
    }
  }

  // --- Favourites and sort (shared) ----------------------------------------
  function normPrefs(raw) {
    const out = { sort: 'list', favorites: [] };
    if (raw && typeof raw === 'object') {
      if (SORTS.includes(raw.sort)) {
        out.sort = raw.sort;
      }
      if (Array.isArray(raw.favorites)) {
        out.favorites = [...new Set(raw.favorites.filter(u => typeof u === 'string'))];
      }
    }
    return out;
  }

  function prefsFingerprint(p) {
    return JSON.stringify(normPrefs(p));
  }

  async function loadPrefs() {
    let remote = normPrefs(null);
    try {
      const res = await fetch(PREFS_URL, { cache: 'no-cache' });
      if (res.ok) {
        remote = normPrefs(await res.json());
      }
    } catch (e) { /* offline or missing file: start empty */ }
    prefsBase = prefsFingerprint(remote);
    prefs = remote;
    prefsDirty = false;
    try {
      const draft = JSON.parse(window.localStorage.getItem(PREFS_KEY) || 'null');
      // A draft only counts while the shared file is still the one it was based on.
      if (draft && draft.base === prefsBase && draft.data) {
        prefs = normPrefs(draft.data);
        prefsDirty = prefsFingerprint(prefs) !== prefsBase;
      } else if (draft) {
        window.localStorage.removeItem(PREFS_KEY);
      }
    } catch (e) { /* ignore */ }
  }

  function touchPrefs() {
    prefsDirty = prefsFingerprint(prefs) !== prefsBase;
    try {
      if (prefsDirty) {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify({ base: prefsBase, data: prefs }));
      } else {
        window.localStorage.removeItem(PREFS_KEY);
      }
    } catch (e) { /* ignore */ }
    renderPrefsUi();
  }

  // Hides the channel list so the video takes the whole width (per device).
  // The layout never changes with the window size: the whole page is scaled instead.
  const SMALL_QUERY = '(min-width: 99999px)';
  function isSmall() {
    return window.matchMedia(SMALL_QUERY).matches;
  }
  function savedFocus() {
    try {
      return window.localStorage.getItem(FOCUS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }
  // Small window: the list is a drawer over the video, opened by the same button.
  function setDrawer(open) {
    byId('iptv-view').classList.toggle('iptv-list-open', open);
    syncToggleButton();
  }
  function syncToggleButton() {
    const view = byId('iptv-view');
    const btn = byId('iptv-toggle-channels');
    const small = isSmall();
    const open = view.classList.contains('iptv-list-open');
    const focus = view.classList.contains('iptv-focus');
    const label = small
      ? (open ? 'Chiudi canali' : 'Canali')
      : (focus ? 'Mostra canali' : 'Nascondi canali');
    btn.querySelector('span').textContent = label;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('active', small ? open : focus);
  }
  function applyLayout() {
    byId('iptv-view').classList.remove('iptv-list-open');
    setFocus(isSmall() || savedFocus(), false);
  }

  function setFocus(on, remember) {
    byId('iptv-view').classList.toggle('iptv-focus', on);
    const btn = byId('iptv-toggle-channels');
    syncToggleButton();
    // With the list hidden the channel name moves into the top bar, like a button.
    const now = byId('iptv-now');
    const target = on ? byId('iptv-toggle-channels').parentNode : document.querySelector('.iptv-stage');
    if (on) {
      btn.after(now);
    } else {
      target.appendChild(now);
    }
    if (remember) {
      try {
        window.localStorage.setItem(FOCUS_KEY, on ? '1' : '0');
      } catch (e) { /* ignore */ }
    }
  }

  // Audio only: the picture is hidden (the sound keeps playing) and HLS streams
  // are limited to their lowest quality to save data. Per device.
  function applyAudioQuality() {
    if (hlsPlayer) {
      hlsPlayer.autoLevelCapping = byId('iptv-view').classList.contains('iptv-audio') ? 0 : -1;
    }
  }

  function setAudioOnly(on, remember) {
    byId('iptv-view').classList.toggle('iptv-audio', on);
    const btn = byId('iptv-audio-btn');
    btn.classList.toggle('active', on);
    btn.querySelector('span').textContent = on ? 'Mostra video' : 'Solo audio';
    btn.title = on ? 'Mostra video' : 'Solo audio';
    btn.setAttribute('aria-label', btn.title);
    byId('iptv-audio-card').classList.toggle('hidden', !on);
    applyAudioQuality();
    if (remember) {
      try {
        window.localStorage.setItem(AUDIO_KEY, on ? '1' : '0');
      } catch (e) { /* ignore */ }
    }
  }

  function syncAudioPlayButton() {
    const paused = byId('iptv-video').paused;
    const btn = byId('iptv-audio-play');
    btn.querySelector('em').className = 'fas ' + (paused ? 'fa-play' : 'fa-pause');
    btn.setAttribute('aria-label', paused ? 'Riproduci' : 'Pausa');
  }

  function renderPrefsUi() {
    byId('iptv-sort').value = prefs.sort;
    byId('iptv-edit').classList.toggle('active', editMode);
    byId('iptv-save-prefs').classList.toggle('hidden', !prefsDirty);
  }

  function toggleFavorite(url) {
    const i = prefs.favorites.indexOf(url);
    if (i >= 0) {
      prefs.favorites.splice(i, 1);
    } else {
      prefs.favorites.push(url);
    }
    touchPrefs();
    applyFilter(true);
  }

  function moveFavorite(url, delta) {
    const i = prefs.favorites.indexOf(url);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= prefs.favorites.length) {
      return;
    }
    [prefs.favorites[i], prefs.favorites[j]] = [prefs.favorites[j], prefs.favorites[i]];
    touchPrefs();
    applyFilter(true);
  }

  function downloadPrefs() {
    const data = JSON.stringify({ version: 1, ...normPrefs(prefs) }, null, 2) + '\n';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    link.download = 'preferenze.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    setStatus('Scaricato preferenze.json: sostituisci playlists/preferenze.json nel repository e fai git push.');
  }

  function compareChannels(a, b) {
    const ca = channels[a];
    const cb = channels[b];
    if (prefs.sort === 'group') {
      const g = (ca[3] || '~').localeCompare(cb[3] || '~', 'it');
      if (g) {
        return g;
      }
    }
    return ca[0].localeCompare(cb[0], 'it', { sensitivity: 'base', numeric: true });
  }

  function applyFilter(keepScroll) {
    const query = byId('iptv-search').value.trim().toLowerCase();
    const group = byId('iptv-group').value;
    filtered = [];
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      if (group && (c[3] || 'Senza gruppo') !== group) {
        continue;
      }
      if (query && !c[0].toLowerCase().includes(query)) {
        continue;
      }
      filtered.push(i);
    }
    const favOrder = new Map(prefs.favorites.map((u, n) => [u, n]));
    const favs = filtered.filter(i => favOrder.has(channels[i][1]))
      .sort((a, b) => favOrder.get(channels[a][1]) - favOrder.get(channels[b][1]));
    let rest = filtered.filter(i => !favOrder.has(channels[i][1]));
    if (prefs.sort !== 'list') {
      rest = rest.sort(compareChannels);
    }
    favCount = favs.length;
    filtered = favs.concat(rest);
    shown = 0;
    const box = byId('iptv-channels');
    const top = keepScroll === true ? box.scrollTop : 0;
    renderChannelChunk(true);
    if (keepScroll === true) {
      box.scrollTop = top;
    }
  }

  // --- Lists management ----------------------------------------------------
  async function selectList(id) {
    stopPlayback();
    playToken++;
    byId('iptv-now').textContent = 'Seleziona un canale';
    byId('iptv-audio-name').textContent = 'Solo audio';
    hideMessage();
    currentIndex = -1;
    state.activeId = id || null;
    saveState();
    const list = activeList();
    if (list && !list.channels && list.url) {
      setStatus('Scarico la lista…');
      try {
        list.channels = await fetchPlaylist(list.url);
        list.updatedAt = Date.now();
        saveState();
      } catch (e) {
        setStatus(fetchErrorText(list.url, e), 'error');
      }
    }
    channels = (list && list.channels) || [];
    renderLists();
    renderGroups();
    applyFilter();
    if (pendingUrl) {
      const wanted = channels.findIndex(c => c[1] === pendingUrl);
      pendingUrl = null;
      if (wanted >= 0) {
        playChannel(wanted);
      }
    }
    if (!byId('iptv-status').classList.contains('error')) {
      countStatus();
    }
    if (list && list.url && list.channels && isStale(list)) {
      autoRefresh(list);
    }
  }

  function isStale(list) {
    return !list.updatedAt || Date.now() - list.updatedAt > AUTO_REFRESH_MS;
  }

  // Silent background update of an address-based list: on failure the saved
  // copy simply stays in use. The playing channel is followed by its address.
  async function autoRefresh(list) {
    try {
      const fresh = await fetchPlaylist(list.url);
      if (!state.lists.includes(list)) {
        return; // deleted in the meantime
      }
      const playingUrl = currentIndex >= 0 && channels[currentIndex] ? channels[currentIndex][1] : null;
      list.channels = fresh;
      list.updatedAt = Date.now();
      saveState();
      if (state.activeId === list.id) {
        channels = fresh;
        currentIndex = playingUrl ? channels.findIndex(c => c[1] === playingUrl) : -1;
        renderLists();
        renderGroups();
        applyFilter();
        setStatus(`${channels.length.toLocaleString('it-IT')} canali · lista aggiornata automaticamente`);
      }
    } catch (e) { /* keep the copy we have */ }
  }

  function addList(name, url, channelData) {
    const list = { id: 'l' + Date.now().toString(36), name, channels: channelData };
    if (url) {
      list.url = url;
      list.updatedAt = Date.now();
    }
    state.lists.push(list);
    state.activeId = list.id;
    const saved = saveState();
    return selectList(list.id).then(() => {
      if (saved === 'slim') {
        setStatus('Lista troppo grande per la memoria del browser: verrà scaricata di nuovo dall\'indirizzo a ogni apertura.', 'warn');
      } else if (saved === 'fail') {
        setStatus('Lista troppo grande per essere salvata sul dispositivo: resta disponibile solo finché non chiudi la pagina.', 'warn');
      }
    });
  }

  async function handleFile(file) {
    setStatus('Leggo il file…');
    try {
      const parsed = parseM3u(await file.text());
      if (parsed === null) {
        setStatus('Questo file è una singola playlist HLS, non una lista di canali: aggiungila con "Da indirizzo".', 'error');
        return;
      }
      if (!parsed.length) {
        setStatus('Nessun canale trovato nel file: è davvero una lista M3U?', 'error');
        return;
      }
      await addList(file.name.replace(/\.[^.]+$/, '') || 'Lista', null, parsed);
    } catch (e) {
      setStatus('Impossibile leggere il file.', 'error');
    }
  }

  async function addFromUrl(name, rawUrl) {
    const url = normalizeUrl(rawUrl);
    setStatus('Scarico la lista…');
    try {
      const parsed = await fetchPlaylist(url);
      await addList(name || listNameFromUrl(url), url, parsed);
      byId('iptv-url-form').classList.add('hidden');
      byId('iptv-url-name').value = '';
      byId('iptv-url-address').value = '';
    } catch (e) {
      setStatus(fetchErrorText(url, e), 'error');
    }
  }

  async function refreshActive() {
    const list = activeList();
    if (!list || !list.url) {
      return;
    }
    setStatus('Aggiorno la lista…');
    try {
      list.channels = await fetchPlaylist(list.url);
      list.updatedAt = Date.now();
      saveState();
      await selectList(list.id);
    } catch (e) {
      setStatus(fetchErrorText(list.url, e), 'error');
    }
  }

  function deleteActive() {
    const list = activeList();
    if (!list || !window.confirm(`Eliminare la lista "${list.name}"?`)) {
      return;
    }
    state.lists = state.lists.filter(l => l.id !== list.id);
    selectList(state.lists.length ? state.lists[0].id : null);
  }

  // --- Playback ------------------------------------------------------------
  function ensureScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => {
          delete scripts[src];
          reject(new Error('script-load'));
        };
        document.head.appendChild(script);
      });
    }
    return scripts[src];
  }

  function showMessage(text, kind) {
    const el = byId('iptv-msg');
    el.textContent = text;
    el.className = kind || '';
  }

  function hideMessage() {
    const el = byId('iptv-msg');
    el.textContent = '';
    el.className = 'hidden';
  }

  function stopPlayback() {
    const video = byId('iptv-video');
    if (detachVideo) {
      detachVideo();
      detachVideo = null;
    }
    if (hlsPlayer) {
      hlsPlayer.destroy();
      hlsPlayer = null;
    }
    if (dashPlayer) {
      try {
        dashPlayer.reset();
      } catch (e) { /* already torn down */ }
      dashPlayer = null;
    }
    if (tsPlayer) {
      try {
        tsPlayer.pause();
        tsPlayer.unload();
        tsPlayer.detachMediaElement();
        tsPlayer.destroy();
      } catch (e) { /* already torn down */ }
      tsPlayer = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function tryPlay(video) {
    const started = video.play();
    if (started && started.catch) {
      started.catch(err => {
        if (err && err.name === 'NotAllowedError') {
          video.muted = true;
          return video.play().catch(() => {});
        }
        return undefined;
      });
    }
  }

  function playPlan(url) {
    const path = url.split(/[?#]/)[0].toLowerCase();
    if (path.endsWith('.m3u8') || /m3u8/i.test(url)) {
      return ['hls'];
    }
    if (path.endsWith('.mpd')) {
      return ['dash'];
    }
    if (path.endsWith('.ts')) {
      return ['ts'];
    }
    if (/\.(mp4|webm|ogv|ogg|mov|m4v|mkv|avi|mp3|aac)$/.test(path)) {
      return ['native'];
    }
    // No telling from the address (typical of provider URLs): try the likely
    // ones. hls.js rejects anything that is not a playlist right away, so it
    // goes first and the slower guesses only run when it gives up.
    return ['hls', 'ts', 'native'];
  }

  // Resolves once the video is actually playing, rejects when this method
  // cannot play the stream. Later failures are reported on the overlay.
  function attemptPlayback(kind, url, token, timeoutMs) {
    return new Promise((resolve, reject) => {
      const video = byId('iptv-video');
      let settled = false;
      let timer = null;

      const lateFailure = () => {
        if (token === playToken) {
          showMessage('Il flusso si è interrotto. Riprova o scegli un altro canale.', 'error');
        }
      };
      const fail = err => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      const onPlaying = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const onError = () => (settled ? lateFailure() : fail(new Error('media-error')));

      video.addEventListener('playing', onPlaying);
      video.addEventListener('error', onError);
      detachVideo = () => {
        clearTimeout(timer);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('error', onError);
      };
      timer = setTimeout(() => fail(new Error('timeout')), timeoutMs);

      const run = async () => {
        if (kind === 'native') {
          video.src = url;
          tryPlay(video);
        } else if (kind === 'hls') {
          await ensureScript(HLS_SRC);
          if (window.Hls && window.Hls.isSupported()) {
            hlsPlayer = new window.Hls({ enableWorker: true });
            hlsPlayer.on(window.Hls.Events.ERROR, (_, data) => {
              if (!data.fatal) {
                return;
              }
              if (!settled) {
                fail(new Error(data.details || 'hls-error'));
              } else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
                hlsPlayer.startLoad();
              } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
                hlsPlayer.recoverMediaError();
              } else {
                lateFailure();
              }
            });
            hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, () => {
              applyAudioQuality();
              tryPlay(video);
            });
            hlsPlayer.loadSource(url);
            hlsPlayer.attachMedia(video);
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url; // Safari / iOS play HLS natively
            tryPlay(video);
          } else {
            throw new Error('hls-unsupported');
          }
        } else if (kind === 'dash') {
          await ensureScript(DASH_SRC);
          if (!window.dashjs) {
            throw new Error('dash-unsupported');
          }
          dashPlayer = window.dashjs.MediaPlayer().create();
          dashPlayer.on('error', () => {
            if (!settled) {
              fail(new Error('dash-error')); // later hiccups are handled by dash.js itself
            }
          });
          dashPlayer.initialize(video, url, true);
        } else {
          await ensureScript(MPEGTS_SRC);
          if (!window.mpegts || !window.mpegts.isSupported()) {
            throw new Error('mpegts-unsupported');
          }
          tsPlayer = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url });
          tsPlayer.on(window.mpegts.Events.ERROR, (type, detail) => {
            if (!settled) {
              fail(new Error(detail || type));
            } else {
              lateFailure();
            }
          });
          tsPlayer.attachMediaElement(video);
          tsPlayer.load();
          Promise.resolve(tsPlayer.play()).catch(() => {});
        }
      };
      run().catch(fail);
    });
  }

  // An HTTPS page may not load http:// streams (mixed content). Many servers
  // answer on HTTPS too, so those channels are tried at the https:// address.
  function isMixedContent(url) {
    return window.location.protocol === 'https:' && /^http:\/\//i.test(url);
  }

  function failureText(url) {
    if (isMixedContent(url)) {
      return 'Questo canale è in HTTP, che il browser blocca su una pagina HTTPS. Ho provato anche la versione HTTPS, ma il server non la offre o non permette l\'accesso da altri siti (CORS): da qui non è riproducibile.';
    }
    return 'Impossibile riprodurre questo canale: può essere offline, in un formato che il browser non supporta (es. MKV/AVI) oppure non accessibile da questo sito (CORS). Prova un altro canale.';
  }

  // --- Audio / video sync: the audio can be delayed (Web Audio) when it runs ahead of the picture ---
  const SYNC_KEY = 'TeslaTheaterIptvSync';
  let syncMap = {};
  let audioCtx = null;
  let delayNode = null;
  let syncMs = 0;

  function loadSync() {
    try {
      syncMap = JSON.parse(window.localStorage.getItem(SYNC_KEY) || '{}') || {};
    } catch (e) {
      syncMap = {};
    }
  }

  function ensureAudioGraph() {
    if (audioCtx) {
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      return false;
    }
    audioCtx = new AC();
    const src = audioCtx.createMediaElementSource(byId('iptv-video'));
    delayNode = audioCtx.createDelay(2);
    src.connect(delayNode);
    delayNode.connect(audioCtx.destination);
    return true;
  }

  // what the delay can actually do right now, shown under the buttons
  function syncState() {
    const el = byId('iptv-sync-state');
    if (!el) {
      return;
    }
    const video = byId('iptv-video');
    const src = video.currentSrc || '';
    let cross = false;
    try {
      cross = !!src && !src.startsWith('blob:') && new URL(src, window.location.href).origin !== window.location.origin;
    } catch (e) { /* ignore */ }
    if (!audioCtx) {
      el.textContent = syncMs > 0 ? 'Ritardo non applicato: il browser non offre Web Audio.' : '';
    } else if (cross && !video.crossOrigin) {
      el.textContent = 'Attenzione: questo flusso non è HLS e potrebbe non consentire il ritardo (audio muto o ritardo ignorato).';
    } else {
      el.textContent = audioCtx.state === 'running' ? 'Ritardo attivo.' : 'Ritardo in attesa: tocca + o − per attivare l\'audio.';
    }
  }

  function applyDelay(ms) {
    syncMs = ms;
    byId('iptv-sync-val').textContent = (ms > 0 ? '+' : '') + ms + ' ms';
    if ((ms > 0 || audioCtx) && ensureAudioGraph()) {
      delayNode.delayTime.value = ms / 1000;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(syncState, syncState);
      }
    }
    syncState();
  }

  function setChannelDelay(ms) {
    const ch = channels[currentIndex];
    applyDelay(ms);
    if (ch) {
      if (ms > 0) {
        syncMap[ch[1]] = ms;
      } else {
        delete syncMap[ch[1]];
      }
      try {
        window.localStorage.setItem(SYNC_KEY, JSON.stringify(syncMap));
      } catch (e) { /* ignore */ }
    }
  }

  async function startPlayback(url) {
    const token = ++playToken;
    stopPlayback();
    showMessage('Caricamento…', 'loading');
    const original = url;
    if (isMixedContent(url)) {
      url = url.replace(/^http:/i, 'https:');
    }
    const kinds = playPlan(url);
    const timeoutMs = kinds.length > 1 ? 8000 : 20000;
    for (const kind of kinds) {
      if (token !== playToken) {
        return;
      }
      try {
        await attemptPlayback(kind, url, token, timeoutMs);
        if (token === playToken) {
          hideMessage();
        }
        return;
      } catch (e) {
        if (token !== playToken) {
          return;
        }
        stopPlayback();
      }
    }
    if (token === playToken) {
      showMessage(failureText(original), 'error');
    }
  }

  function playChannel(index) {
    const channel = channels[index];
    if (!channel) {
      return;
    }
    currentIndex = index;
    try {
      window.localStorage.setItem('TeslaTheaterIptvLast', JSON.stringify({ name: channel[0], url: channel[1], at: Date.now() }));
    } catch (e) { /* ignore */ }
    document.querySelectorAll('#iptv-channels .iptv-channel.playing')
      .forEach(el => el.classList.remove('playing'));
    const row = document.querySelector(`#iptv-channels .iptv-channel[data-index="${index}"]`);
    if (row) {
      row.classList.add('playing');
    }
    byId('iptv-now').textContent = channel[0];
    byId('iptv-audio-name').textContent = channel[0];
    startPlayback(channel[1]);
    applyDelay(syncMap[channel[1]] || 0);
  }

  // --- View ----------------------------------------------------------------
  function bind() {
    if (bound) {
      return;
    }
    bound = true;
    byId('iptv-home').addEventListener('click', closeIptv);
    byId('iptv-list-select').addEventListener('change', e => selectList(e.target.value));
    byId('iptv-add-file').addEventListener('click', () => byId('iptv-file').click());
    byId('iptv-file').addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) {
        handleFile(file);
      }
    });
    byId('iptv-add-url').addEventListener('click', () => {
      const form = byId('iptv-url-form');
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) {
        byId('iptv-url-address').focus();
      }
    });
    byId('iptv-url-cancel').addEventListener('click', () => byId('iptv-url-form').classList.add('hidden'));
    byId('iptv-url-form').addEventListener('submit', e => {
      e.preventDefault();
      const address = byId('iptv-url-address').value.trim();
      if (!address) {
        setStatus('Inserisci l\'indirizzo della lista.', 'error');
        return;
      }
      addFromUrl(byId('iptv-url-name').value.trim(), address);
    });
    byId('iptv-refresh').addEventListener('click', refreshActive);
    byId('iptv-delete').addEventListener('click', deleteActive);
    byId('iptv-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applyFilter(), 150);
    });
    byId('iptv-group').addEventListener('change', () => applyFilter());
    byId('iptv-sort').addEventListener('change', e => {
      prefs.sort = SORTS.includes(e.target.value) ? e.target.value : 'list';
      touchPrefs();
      applyFilter();
    });
    byId('iptv-edit').addEventListener('click', () => {
      editMode = !editMode;
      renderPrefsUi();
      applyFilter(true);
    });
    byId('iptv-save-prefs').addEventListener('click', downloadPrefs);
    byId('iptv-audio-btn').addEventListener('click', () => {
      setAudioOnly(!byId('iptv-view').classList.contains('iptv-audio'), true);
    });
    loadSync();
    byId('iptv-sync-btn').addEventListener('click', () => {
      byId('iptv-sync').classList.toggle('hidden');
      byId('iptv-sync-btn').classList.toggle('active');
      byId('iptv-sync-val').textContent = (syncMs > 0 ? '+' : '') + syncMs + ' ms';
    });
    byId('iptv-sync-minus').addEventListener('click', () => setChannelDelay(Math.max(0, syncMs - 50)));
    byId('iptv-sync-plus').addEventListener('click', () => setChannelDelay(Math.min(1500, syncMs + 50)));
    byId('iptv-sync-reset').addEventListener('click', () => setChannelDelay(0));
    byId('iptv-audio-play').addEventListener('click', () => {
      const video = byId('iptv-video');
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
    byId('iptv-video').addEventListener('play', syncAudioPlayButton);
    byId('iptv-video').addEventListener('pause', syncAudioPlayButton);
    try {
      setAudioOnly(window.localStorage.getItem(AUDIO_KEY) === '1', false);
    } catch (e) { /* ignore */ }
    byId('iptv-toggle-channels').addEventListener('click', () => {
      if (isSmall()) {
        setDrawer(!byId('iptv-view').classList.contains('iptv-list-open'));
      } else {
        setFocus(!byId('iptv-view').classList.contains('iptv-focus'), true);
      }
    });
    applyLayout();
    window.matchMedia(SMALL_QUERY).addEventListener('change', applyLayout);
    document.querySelector('.iptv-stage').addEventListener('click', () => {
      if (isSmall()) {
        setDrawer(false);
      }
    });
    byId('iptv-channels').addEventListener('click', e => {
      if (e.target.closest('.iptv-more')) {
        renderChannelChunk(false);
        return;
      }
      const star = e.target.closest('.iptv-fav');
      if (star) {
        const ch = channels[Number(star.dataset.index)];
        if (ch) {
          toggleFavorite(ch[1]);
        }
        return;
      }
      const move = e.target.closest('.iptv-move');
      if (move) {
        const ch = channels[Number(move.dataset.index)];
        if (ch) {
          moveFavorite(ch[1], move.dataset.move === 'up' ? -1 : 1);
        }
        return;
      }
      const row = e.target.closest('.iptv-channel');
      if (row) {
        playChannel(Number(row.dataset.index));
        if (isSmall()) {
          setDrawer(false);
        }
      }
    });
  }

  // First visit, after "Ripristina", or when a new suggested list was added.
  function addMissingDefaults() {
    let changed = false;
    // One-time clean-up: only the merged list is kept (it replaces the earlier ones).
    if (!state.offered.includes('consolidated-v2')) {
      state.offered.push('consolidated-v2');
      state.lists = state.lists.filter(l => l.id === 'default-italia');
      state.lists.forEach(l => { l.updatedAt = 0; }); // download the current copy again
      if (!state.lists.some(l => l.id === state.activeId)) {
        state.activeId = state.lists.length ? 'default-italia' : null;
      }
      changed = true;
    }
    DEFAULT_LISTS.forEach(def => {
      if (state.offered.includes(def.id)) {
        return;
      }
      state.offered.push(def.id);
      if (!state.lists.some(l => l.id === def.id)) {
        state.lists.push({ ...def });
        if (!state.activeId) {
          state.activeId = def.id;
        }
      }
      changed = true;
    });
    if (changed) {
      saveState();
    }
  }

  function openIptv() {
    if (window.ytCard) {
      window.ytCard.pause();
    }
    // the TV takes over: pause any music that is playing
    if (window.musicApi && window.musicApi.state().playing) {
      window.musicApi.toggle();
    }
    bind();
    loadState();
    addMissingDefaults();
    $('#app-header, #add-app-form').addClass('hidden');
    $('#add-app-btn').removeClass('active');
    byId('iptv-view').classList.remove('hidden');
    document.body.classList.add('iptv-open');
    hideMessage();
    setStatus('');
    const first = state.lists.length ? (activeList() || state.lists[0]).id : null;
    loadPrefs().then(() => {
      renderPrefsUi();
      selectList(first);
    });
  }

  function closeIptv() {
    playToken++;
    stopPlayback();
    byId('iptv-view').classList.add('hidden');
    document.body.classList.remove('iptv-open');
    $('#app-header').removeClass('hidden');
    if (typeof resizeTiles === 'function') {
      resizeTiles();
    }
  }

  // Only address-based lists travel with the settings export: they are small
  // and get downloaded again on the other browser.
  function exportData() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (!raw || !Array.isArray(raw.lists)) {
        return null;
      }
      const lists = raw.lists.filter(l => l.url).map(l => ({ id: l.id, name: l.name, url: l.url }));
      return lists.length
        ? JSON.stringify({ lists, activeId: raw.activeId || null, offered: raw.offered || [] })
        : null;
    } catch (e) {
      return null;
    }
  }

  function reset() {
    playToken++;
    stopPlayback();
    state = { lists: [], activeId: null, offered: [] };
    channels = [];
    prefsDirty = false;
    try {
      window.localStorage.removeItem(PREFS_KEY);
    } catch (e) { /* ignore */ }
  }

  window.openIptv = openIptv;
  window.closeIptv = closeIptv;
  window.iptvPlayUrl = function (url) {
    pendingUrl = url;
    openIptv();
  };
  window.iptvExportData = exportData;
  window.iptvReset = reset;
})();
