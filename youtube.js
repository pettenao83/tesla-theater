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
    const id = typeof it.id === 'string' ? it.id : ((it.id && it.id.videoId) || (sn.resourceId && sn.resourceId.videoId));
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

  async function play(i) {
    const v = items[i];
    if (!v) {
      return;
    }
    idx = i;
    byId('yt-title').textContent = v.title;
    byId('yt-channel').textContent = v.channel;
    byId('yt-view').classList.add('playing');
    byId('yt-back').classList.remove('hidden');
    render();
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
              if (e.data === window.YT.PlayerState.ENDED && idx + 1 < items.length) {
                play(idx + 1);
              }
            },
            onError: () => {
              if (idx + 1 < items.length) {
                play(idx + 1);
              }
            }
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
  }

  function back() {
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

  function openYoutube() {
    bind();
    window.musicApi.init();
    if (window.musicApi.state().playing) {
      window.musicApi.toggle();
    }
    $('#app-header, #apps, #add-app-form').addClass('hidden');
    byId('iptv-view').classList.add('hidden');
    byId('spotify-view').classList.add('hidden');
    byId('app-root').classList.remove('hidden');
    byId('yt-view').classList.remove('hidden');
    byId('yt-login').classList.add('hidden');
    if (!window.musicApi.loggedIn()) {
      needLogin();
      return;
    }
    if (!items.length) {
      openTab('popular');
    }
  }

  function closeYoutube() {
    stopPlayer();
    idx = -1;
    byId('yt-view').classList.remove('playing');
    byId('yt-back').classList.add('hidden');
    byId('yt-view').classList.add('hidden');
    $('#app-header, #apps').removeClass('hidden');
    if (typeof resizeTiles === 'function') {
      resizeTiles();
    }
  }

  window.openYoutube = openYoutube;
}());
