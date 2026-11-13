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
    const id = typeof it.id === 'string' ? it.id : (it.id && it.id.videoId);
    const sn = it.snippet || {};
    const th = sn.thumbnails || {};
    return {
      id,
      title: decode(sn.title),
      channel: decode(sn.channelTitle),
      thumb: (th.medium || th.high || th.default || {}).url || ''
    };
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
      card.addEventListener('click', () => play(i));
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

  async function show(promise) {
    const my = ++token;
    msg('Carico…', false);
    try {
      const d = await promise;
      if (my !== token) {
        return;
      }
      items = (d.items || []).map(toItem).filter(v => v.id);
      idx = -1;
      render();
      msg(items.length ? '' : 'Nessun risultato.', false);
    } catch (e) {
      fail(e);
    }
  }

  function popular() {
    return window.musicApi.call('/videos', { part: 'snippet', chart: 'mostPopular', regionCode: 'IT', maxResults: '24' });
  }

  function search(q) {
    return window.musicApi.call('/search', { part: 'snippet', q, type: 'video', maxResults: '24', safeSearch: 'moderate' });
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
    byId('yt-login').addEventListener('click', () => window.musicApi.login());
    byId('yt-form').addEventListener('submit', e => {
      e.preventDefault();
      const q = byId('yt-q').value.trim();
      if (q) {
        byId('yt-view').classList.remove('playing');
        byId('yt-back').classList.add('hidden');
        stopPlayer();
        show(search(q));
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
      show(popular());
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
