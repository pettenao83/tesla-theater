/*
 * YouTube inside the launcher: search and play videos in the page (official IFrame player).
 * Search and the "popular" shelf use the YouTube Data API through the Google session of the music view.
 */
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  let yt = null;
  let ytPromise = null;
  let items = [];
  let idx = -1;
  let bound = false;
  let token = 0;
  let isPlaying = false;

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
        if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
          const s = document.createElement('script');
          s.src = 'https://www.youtube.com/iframe_api';
          s.onerror = () => {
            ytPromise = null;
            reject(new Error('YouTube non raggiungibile.'));
          };
          document.head.appendChild(s);
        }
      });
    }
    return ytPromise;
  }

  function decode(s) {
    const t = document.createElement('textarea');
    t.innerHTML = s || '';
    return t.value;
  }

  function msg(text, isError) {
    const m = byId('yt-msg');
    m.textContent = text || '';
    m.classList.toggle('hidden', !text);
    m.classList.toggle('error', !!isError);
  }

  function toItem(it) {
    const sn = it.snippet || {};
    // playlist items carry the video id in resourceId (their own `id` is the list entry);
    // search results use id.videoId; videos.list uses the plain id
    const id = (sn.resourceId && sn.resourceId.videoId) || (it.id && it.id.videoId) || (typeof it.id === 'string' ? it.id : '');
    const th = sn.thumbnails || {};
    return {
      id,
      title: decode(sn.title),
      channel: decode(sn.videoOwnerChannelTitle || sn.channelTitle),
      thumb: (th.medium || th.high || th.default || {}).url || '',
      date: sn.publishedAt || ''
    };
  }

  const call = (path, params) => window.musicApi.call(path, params);
  const uploads = {};   // channelId -> uploads playlist id

  const thumbOf = sn => {
    const th = (sn && sn.thumbnails) || {};
    return (th.medium || th.high || th.default || {}).url || '';
  };

  async function uploadsOf(ids) {
    const need = ids.filter(i => !uploads[i]);
    for (let k = 0; k < need.length; k += 50) {
      const d = await call('/channels', { part: 'contentDetails', id: need.slice(k, k + 50).join(','), maxResults: '50' });
      (d.items || []).forEach(c => {
        uploads[c.id] = c.contentDetails.relatedPlaylists.uploads;
      });
    }
    return ids.map(i => uploads[i]).filter(Boolean);
  }

  const tabs = {
    popular: () => call('/videos', { part: 'snippet', chart: 'mostPopular', regionCode: 'IT', maxResults: '24' }).then(d => ({ items: (d.items || []).map(toItem) })),
    liked: () => call('/playlistItems', { part: 'snippet', playlistId: 'LL', maxResults: '48' }).then(d => ({ items: (d.items || []).map(toItem) })),
    subs: async () => {
      const d = await call('/subscriptions', { part: 'snippet', mine: 'true', maxResults: '50', order: 'alphabetical' });
      return {
        items: (d.items || []).map(it => ({
          kind: 'channel',
          id: it.snippet.resourceId.channelId,
          title: decode(it.snippet.title),
          channel: '',
          thumb: thumbOf(it.snippet)
        })),
        empty: 'Non risulti iscritto a nessun canale.'
      };
    },
    lists: async () => {
      const d = await call('/playlists', { part: 'snippet', mine: 'true', maxResults: '50' });
      return {
        items: (d.items || []).map(it => ({ kind: 'playlist', id: it.id, title: decode(it.snippet.title), channel: '', thumb: thumbOf(it.snippet) })),
        empty: 'Nessuna playlist.'
      };
    },
    feed: async () => {
      const d = await call('/subscriptions', { part: 'snippet', mine: 'true', maxResults: '50', order: 'relevance' });
      const ids = (d.items || []).map(it => it.snippet.resourceId.channelId).slice(0, 20);
      const pls = await uploadsOf(ids);
      const parts = await Promise.all(pls.map(pl => call('/playlistItems', { part: 'snippet', playlistId: pl, maxResults: '3' }).catch(() => ({ items: [] }))));
      const all = [].concat(...parts.map(x => x.items || [])).map(toItem).filter(v => v.id);
      all.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return { items: all.slice(0, 36), empty: 'Nessuna novità dai tuoi canali.' };
    }
  };

  async function openContainer(it) {
    if (it.kind === 'channel') {
      const pl = (await uploadsOf([it.id]))[0];
      if (!pl) {
        throw new Error('Canale non disponibile.');
      }
      const d = await call('/playlistItems', { part: 'snippet', playlistId: pl, maxResults: '36' });
      return { items: (d.items || []).map(toItem) };
    }
    const d = await call('/playlistItems', { part: 'snippet', playlistId: it.id, maxResults: '48' });
    return { items: (d.items || []).map(toItem) };
  }

  function openTab(name) {
    document.querySelectorAll('.yt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    byId('yt-view').classList.remove('playing');
    byId('yt-back').classList.add('hidden');
    stopPlayer();
    run(tabs[name]());
  }

  function render() {
    const list = byId('yt-list');
    list.innerHTML = '';
    items.forEach((v, i) => {
      const card = document.createElement('div');
      card.className = 'yt-card' + (i === idx ? ' on' : '');
      card.tabIndex = 0;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = v.thumb;
      const t = document.createElement('b');
      t.textContent = v.title;
      const c = document.createElement('span');
      c.textContent = v.channel;
      const box = document.createElement('div');
      box.className = 'yt-txt';
      box.append(t, c);
      card.append(img, box);
      if (v.kind) {
        card.classList.add('container', v.kind);
        card.addEventListener('click', () => run(openContainer(v)));
      } else {
        card.addEventListener('click', () => play(i));
      }
      list.appendChild(card);
    });
    setTimeout(place, 0);
  }

  function needLogin() {
    byId('yt-login').classList.remove('hidden');
    msg('Per cercare e vedere i video accedi con Google (una volta sola).', false);
  }

  function fail(e) {
    if (e && e.auth) {
      needLogin();
      return;
    }
    if (e && e.status === 403) {
      msg('Google non consente la richiesta (quota giornaliera finita o API non attiva).', true);
      return;
    }
    msg((e && e.message) || 'Errore di rete.', true);
  }

  async function run(promise) {
    const my = ++token;
    msg('Carico…', false);
    try {
      const d = await promise;
      if (my !== token) {
        return;
      }
      items = (d.items || []).filter(v => v.id);
      idx = -1;
      render();
      msg(items.length ? '' : (d.empty || 'Nessun risultato.'), false);
    } catch (e) {
      fail(e);
    }
  }

  function search(q) {
    return call('/search', { part: 'snippet', q, type: 'video', maxResults: '24', safeSearch: 'moderate' })
      .then(d => ({ items: (d.items || []).map(toItem) }));
  }

  function onPlayerError(code) {
    const reason = {
      2: 'ID video non valido.',
      5: 'Errore del player.',
      100: 'Video non trovato o privato.',
      101: 'Il proprietario non permette la riproduzione fuori da YouTube.',
      150: 'Il proprietario non permette la riproduzione fuori da YouTube.'
    }[code] || ('Errore del player (' + code + ').');
    const skip = (code === 100 || code === 101 || code === 150) && idx + 1 < items.length;
    msg(reason + (skip ? ' Passo al successivo…' : ' Usa "Apri su YouTube".'), true);
    if (skip) {
      const at = idx;
      setTimeout(() => {
        if (idx === at) {
          play(idx + 1);
        }
      }, 2500);
    }
  }

  function watchStart(at) {
    setTimeout(() => {
      if (idx === at && yt && yt.getPlayerState && yt.getPlayerState() === -1 && byId('yt-msg').classList.contains('hidden')) {
        msg('Il video non parte: prova "Apri su YouTube" sotto il titolo.', true);
      }
    }, 8000);
  }

  async function play(i) {
    const v = items[i];
    if (!v) {
      return;
    }
    idx = i;
    listMode = false;
    byId('yt-title').textContent = v.title;
    byId('yt-channel').textContent = v.channel;
    byId('yt-ext').href = 'https://www.youtube.com/watch?v=' + v.id;
    msg('', false);
    watchStart(i);
    byId('yt-view').classList.add('playing');
    byId('yt-back').classList.remove('hidden');
    render();
    refreshCard();
    setTimeout(place, 50);
    try {
      await loadYT();
    } catch (e) {
      msg(e.message, true);
      return;
    }
    if (!yt) {
      await new Promise(resolve => {
        yt = new window.YT.Player('yt-player', {
          width: '100%',
          height: '100%',
          videoId: v.id,
          playerVars: { playsinline: 1, rel: 0, autoplay: 1, origin: window.location.origin },
          events: {
            onReady: () => resolve(),
            onStateChange: e => {
              isPlaying = e.data === window.YT.PlayerState.PLAYING;
              refreshCard();
              if (e.data === window.YT.PlayerState.ENDED && idx + 1 < items.length) {
                play(idx + 1);
              }
            },
            onError: e => onPlayerError(e.data)
          }
        });
      });
      return;
    }
    yt.loadVideoById(v.id);
  }

  function stopPlayer() {
    if (yt && yt.stopVideo) {
      yt.stopVideo();
    }
    isPlaying = false;
  }

  function setCinema(on) {
    const v = byId('yt-view');
    v.classList.toggle('cinema', !!on);
    const b = byId('yt-cinema');
    b.classList.toggle('active', !!on);
    b.title = on ? 'Mostra elenco e comandi' : 'Modalità cinema';
    b.querySelector('em').className = 'fas fa-' + (on ? 'compress' : 'film');
    b.querySelector('.lbl').textContent = on ? 'Esci' : 'Cinema';
    [50, 200, 450].forEach(ms => setTimeout(place, ms));
  }

  function back() {
    setCinema(false);
    stopPlayer();
    idx = -1;
    byId('yt-view').classList.remove('playing');
    byId('yt-back').classList.add('hidden');
    render();
  }

  function bind() {
    if (bound) {
      return;
    }
    bound = true;
    byId('yt-home').addEventListener('click', closeYoutube);
    byId('yt-back').addEventListener('click', back);
    byId('yt-cinema').addEventListener('click', () => setCinema(!byId('yt-view').classList.contains('cinema')));
    document.querySelectorAll('.yt-tab').forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab)));
    byId('yt-login').addEventListener('click', () => window.musicApi.login());
    byId('yt-form').addEventListener('submit', e => {
      e.preventDefault();
      const q = byId('yt-q').value.trim();
      if (q) {
        byId('yt-view').classList.remove('playing');
        byId('yt-back').classList.add('hidden');
        stopPlayer();
        document.querySelectorAll('.yt-tab').forEach(b => b.classList.remove('active'));
        run(search(q));
      }
    });
  }

  function openYoutube(list, start, cinema) {
    bind();
    if (cinema) {
      setTimeout(() => setCinema(true), 0);
    }
    window.musicApi.init();
    if (window.musicApi.state().playing) {
      window.musicApi.toggle();
    }
    $('#app-header, #apps, #add-app-form').addClass('hidden');
    byId('iptv-view').classList.add('hidden');
    byId('spotify-view').classList.add('hidden');
    byId('app-root').classList.remove('hidden');
    byId('yt-view').classList.remove('hidden');
    setTimeout(place, 100);
    byId('yt-login').classList.add('hidden');
    if (!window.musicApi.loggedIn()) {
      needLogin();
      return;
    }
    if (Array.isArray(list) && list.length) {
      items = list;
      idx = -1;
      msg('', false);
      document.querySelectorAll('.yt-tab').forEach(b => b.classList.remove('active'));
      render();
      play(start || 0);
      return;
    }
    if (!items.length) {
      openTab('popular');
    }
  }

  // ---- shelf inside the home card ----
  let shelf = { at: 0, items: [] };

  async function loadShelf() {
    if (Date.now() - shelf.at < 600000 && shelf.items.length) {
      return shelf.items;
    }
    let list = (await tabs.feed()).items;
    if (!list.length) {
      list = (await tabs.popular()).items;
    }
    shelf = { at: Date.now(), items: list.filter(v => v.id).slice(0, 8) };
    return shelf.items;
  }

  let cardHost = null;

  function refreshCard() {
    if (cardHost && !cardHost.classList.contains('hidden')) {
      renderCard(cardHost);
    }
  }

  function toggleCard() {
    if (!yt || !yt.getPlayerState) {
      return;
    }
    if (yt.getPlayerState() === 1) {
      yt.pauseVideo();
    } else {
      yt.playVideo();
    }
  }

  function pauseCard() {
    if (yt && yt.pauseVideo && isPlaying) {
      yt.pauseVideo();
    }
  }

  let listMode = false;

  function icon(name, label, fn, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'actionbutton ' + (cls || 'secondary');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = '<em class="fas fa-' + name + '"></em>';
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    return b;
  }

  // The player lives in a fixed host outside the scaled pages and is laid over
  // whichever area is on screen: the YouTube view, the home card, or nowhere (sound only).
  function place() {
    const host = byId('yt-host');
    if (!host) {
      return;
    }
    let target = null;
    if (!byId('yt-view').classList.contains('hidden')) {
      target = idx >= 0 ? byId('yt-stage') : null;
    } else if (byId('dash-now').classList.contains('mode-video') && !listMode && idx >= 0) {
      target = byId('dash-yt-vid');
    }
    const panelOpen = !!document.querySelector('#dash-settings:not(.hidden), #add-app-form:not(.hidden)');
    const f = host.querySelector('iframe');
    if (target && !panelOpen && target.offsetWidth > 0) {
      const r = target.getBoundingClientRect();
      host.style.cssText = 'position:fixed;z-index:60;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border-radius:14px;overflow:hidden;background:#000;';
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
  }

  async function renderCard(host) {
    cardHost = host;
    host.innerHTML = '';
    const now = idx >= 0 ? items[idx] : null;
    if (now && !listMode) {
      const vid = document.createElement('div');
      vid.id = 'dash-yt-vid';
      vid.className = 'dash-yt-vid';
      const row = document.createElement('div');
      row.className = 'dash-yt-nowrow';
      const tx = document.createElement('div');
      tx.className = 'dash-yt-nowtxt';
      const tt = document.createElement('b');
      tt.textContent = now.title;
      const ch = document.createElement('span');
      ch.textContent = now.channel;
      tx.append(tt, ch);
      row.append(
        tx,
        icon(isPlaying ? 'pause' : 'play', 'Riproduci / pausa', toggleCard, 'dash-yt-play'),
        icon('th-large', 'Altri video', () => { listMode = true; renderCard(host); }),
        icon('expand', 'Cinema', () => openYoutube(null, 0, true)),
        icon('times', 'Chiudi video', () => { stopPlayer(); idx = -1; renderCard(host); })
      );
      host.append(vid, row);
      requestAnimationFrame(place);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'dash-yt-grid';
    const bar = document.createElement('div');
    bar.className = 'dash-yt-bar';
    if (now) {
      bar.appendChild(icon('arrow-left', 'Torna al video', () => { listMode = false; renderCard(host); }));
    }
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'actionbutton secondary';
    all.innerHTML = '<em class="fab fa-youtube"></em> Apri YouTube';
    all.addEventListener('click', e => { e.stopPropagation(); openYoutube(); });
    bar.appendChild(all);
    host.append(grid, bar);
    requestAnimationFrame(place);
    window.musicApi.init();
    if (!window.musicApi.loggedIn()) {
      grid.innerHTML = '<p class="dash-yt-note">Accedi con Google per vedere i video dei tuoi canali.</p>';
      return;
    }
    grid.innerHTML = '<p class="dash-yt-note">Carico…</p>';
    try {
      const list = await loadShelf();
      grid.innerHTML = '';
      list.forEach((v, i) => {
        const c = document.createElement('div');
        c.className = 'dash-yt-item';
        const img = document.createElement('img');
        img.alt = '';
        img.src = v.thumb;
        const t = document.createElement('span');
        t.textContent = v.title;
        c.append(img, t);
        c.addEventListener('click', e => {
          e.stopPropagation();
          items = list;
          play(i);
        });
        grid.appendChild(c);
      });
    } catch (e) {
      grid.innerHTML = '<p class="dash-yt-note">Video non disponibili al momento.</p>';
    }
  }

  window.ytCard = { render: renderCard, pause: pauseCard, place };
  window.addEventListener('resize', () => setTimeout(place, 150));

  function closeYoutube() {
    // the video keeps playing (sound only) and shows up in the home "Video" card
    setCinema(false);
    byId('yt-view').classList.add('hidden');
    listMode = false;
    refreshCard();
    place();
    $('#app-header, #apps').removeClass('hidden');
    if (typeof resizeTiles === 'function') {
      resizeTiles();
    }
  }

  window.openYoutube = openYoutube;
}());
