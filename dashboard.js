/*
 * Home dashboard: clock, weather, Spotify "now playing" with basic controls,
 * and a choice of looks (Neon / Minimale / Cover). Settings live in this browser.
 */
(function () {
  'use strict';

  const KEY = 'TeslaTheaterDash';
  const THEMES = ['neon', 'minimal', 'cover', 'android-dark', 'android-light', 'ios-dark', 'ios-light'];
  const DEFAULT_CITY = { name: 'Spinea (Venezia)', lat: 45.49, lon: 12.15 };
  const cfg = { theme: 'neon', city: DEFAULT_CITY, news: 'ansa' };
  let player = null;
  let weatherTimer = null;
  let started = false;

  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const byId = id => document.getElementById(id);

  function load() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(KEY) || '{}');
      if (THEMES.includes(saved.theme)) {
        cfg.theme = saved.theme;
      }
      if (typeof saved.news === 'string' && NEWS_SOURCES[saved.news]) {
        cfg.news = saved.news;
      }
      if (saved.city && typeof saved.city.lat === 'number' && typeof saved.city.lon === 'number') {
        cfg.city = saved.city;
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch (e) { /* ignore */ }
  }

  function relayout() {
    if (typeof resizeTiles === 'function') {
      resizeTiles();
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = cfg.theme;
    document.querySelectorAll('.dash-theme').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === cfg.theme);
    });
    relayout();
  }

  // ---------- clock ----------

  function tickClock() {
    const now = new Date();
    byId('dash-time').textContent = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    byId('dash-date').textContent = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ---------- weather (Open-Meteo, no key) ----------

  function describe(code) {
    if (code === 0) { return ['fa-sun', 'Sereno']; }
    if (code <= 2) { return ['fa-cloud-sun', 'Poco nuvoloso']; }
    if (code === 3) { return ['fa-cloud', 'Coperto']; }
    if (code === 45 || code === 48) { return ['fa-smog', 'Nebbia']; }
    if (code >= 51 && code <= 57) { return ['fa-cloud-rain', 'Pioggerella']; }
    if (code >= 61 && code <= 67) { return ['fa-cloud-showers-heavy', 'Pioggia']; }
    if (code >= 71 && code <= 77) { return ['fa-snowflake', 'Neve']; }
    if (code >= 80 && code <= 82) { return ['fa-cloud-showers-heavy', 'Rovesci']; }
    if (code >= 95) { return ['fa-bolt', 'Temporale']; }
    return ['fa-cloud', 'Variabile'];
  }

  async function loadWeather() {
    byId('dash-city').textContent = cfg.city.name;
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + cfg.city.lat +
        '&longitude=' + cfg.city.lon + '&current=temperature_2m,weather_code&timezone=auto';
      const r = await fetch(url);
      if (!r.ok) {
        throw new Error('HTTP ' + r.status);
      }
      const j = await r.json();
      const d = describe(j.current.weather_code);
      byId('dash-wicon').className = 'fas ' + d[0];
      byId('dash-temp').textContent = Math.round(j.current.temperature_2m) + '°';
      byId('dash-wtext').textContent = d[1];
    } catch (e) {
      byId('dash-wtext').textContent = 'Meteo non disponibile';
    }
    relayout();
  }

  async function searchCity() {
    const q = byId('dash-city-input').value.trim();
    const msg = byId('dash-city-msg');
    if (!q) {
      msg.textContent = 'Scrivi il nome di una città.';
      return;
    }
    msg.textContent = 'Cerco…';
    try {
      const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' +
        encodeURIComponent(q) + '&count=1&language=it&format=json');
      const j = await r.json();
      const hit = j.results && j.results[0];
      if (!hit) {
        msg.textContent = 'Città non trovata.';
        return;
      }
      cfg.city = {
        name: hit.name + (hit.admin1 ? ' (' + hit.admin1 + ')' : ''),
        lat: hit.latitude,
        lon: hit.longitude
      };
      save();
      msg.textContent = 'Meteo per ' + cfg.city.name;
      loadWeather();
    } catch (e) {
      msg.textContent = 'Ricerca non riuscita, riprova.';
    }
  }


  // ---------- news (RSS in italiano) ----------

  const PROXY = 'https://api.rss2json.com/v1/api.json?rss_url=';
  const NEWS_SOURCES = {
    ansa: { name: 'ANSA', url: 'https://www.ansa.it/sito/ansait_rss.xml' },
    corriere: { name: 'Corriere della Sera', url: 'https://xml2.corriereobjects.it/rss/homepage.xml', direct: true },
    repubblica: { name: 'la Repubblica', url: 'https://www.repubblica.it/rss/homepage/rss2.0.xml' },
    sky: { name: 'Sky TG24', url: 'https://tg24.sky.it/rss/tg24.xml' },
    rai: { name: 'Rai News', url: 'https://www.rainews.it/rss/tutti' },
    google: { name: 'Google Notizie', url: 'https://news.google.com/rss?hl=it&gl=IT&ceid=IT:it' }
  };
  const NEWS_KEY = 'TeslaTheaterNews';
  const NEWS_TTL = 10 * 60 * 1000;
  let news = { source: '', items: [], at: 0 };
  let newsPage = 0;

  function https(u) {
    return u ? String(u).replace(/^http:\/\//i, 'https://') : '';
  }

  function imgFromHtml(html) {
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || '');
    return m ? https(m[1]) : '';
  }

  function ago(ms) {
    if (!ms) {
      return '';
    }
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) { return 'adesso'; }
    if (min < 60) { return min + ' min fa'; }
    const h = Math.round(min / 60);
    return h < 24 ? h + ' h fa' : Math.round(h / 24) + ' g fa';
  }

  async function fetchFeed(id) {
    const src = NEWS_SOURCES[id];
    if (src.direct) {
      const r = await fetch(src.url);
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
      return Array.from(xml.querySelectorAll('item')).slice(0, 12).map(it => {
        const q = t => { const e = it.querySelector(t); return e ? e.textContent : ''; };
        const enc = it.querySelector('enclosure');
        return {
          title: q('title').trim(),
          link: q('link').trim(),
          at: Date.parse(q('pubDate')) || 0,
          img: https((enc && enc.getAttribute('url')) || imgFromHtml(q('description')))
        };
      });
    }
    const r = await fetch(PROXY + encodeURIComponent(src.url));
    if (!r.ok) { throw new Error('HTTP ' + r.status); }
    const j = await r.json();
    if (j.status !== 'ok') { throw new Error(j.message || 'feed'); }
    return (j.items || []).slice(0, 12).map(it => ({
      title: String(it.title || '').trim(),
      link: it.link,
      at: Date.parse(String(it.pubDate || '').replace(' ', 'T') + 'Z') || 0,
      img: https(it.thumbnail || (it.enclosure && /image/.test(it.enclosure.type || 'image') && it.enclosure.link) || imgFromHtml(it.description || it.content))
    }));
  }

  async function loadNews(force) {
    try {
      const c = JSON.parse(window.localStorage.getItem(NEWS_KEY) || 'null');
      if (c && c.items && c.source === cfg.news) {
        news = c;
      }
    } catch (e) { /* ignore */ }
    if (!force && news.source === cfg.news && Date.now() - news.at < NEWS_TTL) {
      renderNews();
      return;
    }
    renderNews();
    let items = null;
    let used = cfg.news;
    try {
      items = await fetchFeed(cfg.news);
    } catch (e) {
      if (cfg.news !== 'corriere') {
        try {
          items = await fetchFeed('corriere');
          used = 'corriere';
        } catch (e2) { /* keep the cached headlines */ }
      }
    }
    if (items && items.length) {
      news = { source: used, items, at: Date.now() };
      newsPage = 0;
      try {
        window.localStorage.setItem(NEWS_KEY, JSON.stringify(news));
      } catch (e) { /* ignore */ }
    }
    renderNews();
  }

  function renderNews() {
    const list = byId('news-list');
    const items = news.items || [];
    const src = NEWS_SOURCES[news.source] || NEWS_SOURCES[cfg.news];
    byId('news-chip').textContent = src.name;
    byId('news-age').textContent = items.length ? 'Aggiornato ' + ago(news.at) : 'Carico le notizie…';
    list.textContent = '';
    const pages = Math.max(1, Math.ceil(items.length / 3));
    newsPage = newsPage % pages;
    items.slice(newsPage * 3, newsPage * 3 + 3).forEach(it => {
      const a = document.createElement('a');
      a.className = 'news-item';
      a.href = it.link;
      const thumb = it.img ? document.createElement('img') : document.createElement('span');
      if (it.img) {
        thumb.className = 'news-thumb';
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.src = it.img;
        thumb.onerror = () => { thumb.style.visibility = 'hidden'; };
      } else {
        thumb.className = 'news-thumb news-ph';
        thumb.innerHTML = '<em class="fas fa-newspaper"></em>';
      }
      const text = document.createElement('span');
      text.className = 'news-text';
      const t = document.createElement('span');
      t.className = 'news-title';
      t.textContent = it.title;
      const m = document.createElement('span');
      m.className = 'news-meta';
      m.textContent = ago(it.at);
      text.appendChild(t);
      text.appendChild(m);
      a.appendChild(thumb);
      a.appendChild(text);
      list.appendChild(a);
    });
    const dots = byId('news-dots');
    dots.textContent = '';
    for (let i = 0; i < pages; i++) {
      const d = document.createElement('i');
      d.className = i === newsPage ? 'on' : '';
      dots.appendChild(d);
    }
    relayout();
  }

  function turnNews(step) {
    const pages = Math.max(1, Math.ceil((news.items || []).length / 3));
    newsPage = (newsPage + step + pages) % pages;
    renderNews();
  }

  // ---------- Spotify now playing ----------

  function spotify() {
    return window.spotifyApi && window.spotifyApi.connected() ? window.spotifyApi : null;
  }

  function fmtImage(item) {
    const imgs = (item && ((item.album && item.album.images) || item.images)) || [];
    return imgs.length ? imgs[0].url : '';
  }

  function renderNow() {
    const sp = spotify();
    const item = player && player.item;
    byId('dash-connect').classList.toggle('hidden', !!sp);
    byId('dash-ctl').classList.toggle('hidden', !sp);
    const cover = byId('dash-cover');
    const url = fmtImage(item);
    cover.classList.toggle('empty', !url);
    if (url) {
      if (cover.getAttribute('src') !== url) {
        cover.src = url;
      }
    } else if (cover.getAttribute('src') !== BLANK) {
      cover.src = BLANK;
    }
    if (!sp) {
      byId('dash-track').textContent = 'Spotify non collegato';
      byId('dash-artist').textContent = 'Collegalo per vedere cosa stai ascoltando.';
      byId('dash-prog').style.width = '0%';
      return;
    }
    byId('dash-track').textContent = item ? item.name : 'Nessuna riproduzione';
    byId('dash-artist').textContent = item
      ? ((item.artists && item.artists.map(a => a.name).join(', ')) || (item.show && item.show.publisher) || '')
      : 'Avvia Spotify sull\'auto o sul telefono.';
    const playing = !!(player && player.is_playing);
    byId('dash-play').innerHTML = '<em class="fas fa-' + (playing ? 'pause' : 'play') + '"></em>';
    byId('dash-play').setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
    tickProgress();
    relayout();
  }

  function tickProgress() {
    if (!player || !player.item || !player.item.duration_ms) {
      byId('dash-prog').style.width = '0%';
      return;
    }
    const pos = (player.progress_ms || 0) + (player.is_playing ? Date.now() - player._at : 0);
    byId('dash-prog').style.width = Math.min(100, (pos / player.item.duration_ms) * 100) + '%';
  }

  async function pollNow() {
    const home = byId('dash');
    if (document.hidden || !home || home.offsetParent === null) {
      return;
    }
    const sp = spotify();
    if (!sp) {
      player = null;
      renderNow();
      return;
    }
    try {
      const p = await sp.call('/me/player?additional_types=episode');
      player = p ? Object.assign(p, { _at: Date.now() }) : null;
    } catch (e) {
      if (e && e.auth) {
        player = null;
      }
    }
    renderNow();
  }

  async function control(path, method) {
    const sp = spotify();
    if (!sp) {
      return;
    }
    try {
      await sp.call(path, { method: method || 'PUT' });
    } catch (e) { /* the next poll shows the real state */ }
    setTimeout(pollNow, 400);
  }

  function bind() {
    byId('dash-connect').addEventListener('click', () => {
      if (typeof openSpotify === 'function') {
        openSpotify();
      }
    });
    byId('dash-now').addEventListener('click', e => {
      if (e.target.closest('button') || !spotify()) {
        return;
      }
      if (typeof openSpotify === 'function') {
        openSpotify();
      }
    });
    byId('dash-play').addEventListener('click', () => {
      if (player && player.is_playing) {
        player.is_playing = false;
        renderNow();
        control('/me/player/pause');
      } else {
        if (player) {
          player.is_playing = true;
          player._at = Date.now();
          renderNow();
        }
        control('/me/player/play');
      }
    });
    byId('dash-next').addEventListener('click', () => control('/me/player/next', 'POST'));
    byId('dash-prev').addEventListener('click', () => control('/me/player/previous', 'POST'));
    byId('dash-settings-btn').addEventListener('click', () => {
      byId('dash-settings').classList.toggle('hidden');
      byId('dash-settings-btn').classList.toggle('active');
      byId('dash-city-input').value = '';
      byId('dash-city-msg').textContent = 'Città del meteo: ' + cfg.city.name;
      relayout();
    });
    document.querySelectorAll('.dash-theme').forEach(b => {
      b.addEventListener('click', () => {
        cfg.theme = b.dataset.theme;
        save();
        applyTheme();
      });
    });
    byId('dash-city-search').addEventListener('click', searchCity);
    byId('news-prev').addEventListener('click', () => turnNews(-1));
    byId('news-next').addEventListener('click', () => turnNews(1));
    const sel = byId('dash-news-source');
    sel.value = cfg.news;
    sel.addEventListener('change', () => {
      cfg.news = sel.value;
      save();
      newsPage = 0;
      news = { source: '', items: [], at: 0 };
      loadNews(true);
    });
    byId('dash-city-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchCity();
      }
    });
  }

  function start() {
    if (started || !byId('dash')) {
      return;
    }
    started = true;
    load();
    bind();
    applyTheme();
    tickClock();
    setInterval(tickClock, 10000);
    loadWeather();
    weatherTimer = setInterval(loadWeather, 15 * 60 * 1000);
    loadNews(false);
    setInterval(() => loadNews(true), NEWS_TTL);
    setInterval(() => { if (!document.hidden && byId('dash').offsetParent !== null) { turnNews(1); } }, 14000);
    renderNow();
    pollNow();
    setInterval(pollNow, 4000);
    setInterval(tickProgress, 1000);
    // The dashboard changes the header height, so the app tiles are sized again.
    setTimeout(relayout, 50);
    window.addEventListener('load', relayout);
  }

  window.dashReset = function () {
    try {
      window.localStorage.removeItem(KEY);
    } catch (e) { /* ignore */ }
    cfg.theme = 'neon';
    cfg.city = DEFAULT_CITY;
    cfg.news = 'ansa';
    try {
      window.localStorage.removeItem(NEWS_KEY);
    } catch (e) { /* ignore */ }
    if (started) {
      applyTheme();
      loadWeather();
    }
  };

  // Apply the saved look before the first paint of the tiles.
  document.addEventListener('DOMContentLoaded', start);
}());
