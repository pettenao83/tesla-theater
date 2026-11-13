/*
 * Home dashboard: YouTube Music "now playing" with basic controls,
 * and a choice of looks (Neon / Minimale / Cover). Settings live in this browser.
 */
(function () {
  'use strict';

  const KEY = 'TeslaTheaterDash';
  const STYLES = ['neon', 'minimal', 'cover', 'android', 'ios'];
  const MODES = ['auto', 'light', 'dark'];
  const cfg = { theme: 'ios', mode: 'auto', accent: '', news: 'sky', newsV: 2 };
  let player = null;
  let started = false;

  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const byId = id => document.getElementById(id);

  function load() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(KEY) || '{}');
      const legacy = /^(android|ios)-(dark|light)$/.exec(saved.theme || '');
      if (legacy) {
        cfg.theme = legacy[1];
        cfg.mode = legacy[2];
      } else if (STYLES.includes(saved.theme)) {
        cfg.theme = saved.theme;
      }
      if (MODES.includes(saved.mode)) {
        cfg.mode = saved.mode;
      }
      if (typeof saved.accent === 'string' && /^#[0-9a-f]{6}$/i.test(saved.accent)) {
        cfg.accent = saved.accent;
      }
      if (typeof saved.news === 'string' && NEWS_SOURCES[saved.news]) {
        // the old default (ANSA, no photos) moves to Sky TG24 once
        cfg.news = saved.newsV !== 2 && saved.news === 'ansa' ? 'sky' : saved.news;
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

  // ---------- accent colour ----------

  const ACCENTS = [
    ['', 'Predefinito'],
    ['#0a84ff', 'Blu'],
    ['#7c5cff', 'Viola'],
    ['#ff4fa3', 'Rosa'],
    ['#e82127', 'Rosso'],
    ['#ff8a1f', 'Arancio'],
    ['#f2b705', 'Giallo'],
    ['#2fbf71', 'Verde'],
    ['#14b8b8', 'Turchese']
  ];

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // The three own icons are drawn here so they take the accent colour of the style.
  function iconSvg(name, a, b, t) {
    const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">';
    const g = '<g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="10">';
    let body = '';
    if (name === 'iptv') {
      body = g + '<path d="M96 50 L128 84 L160 50" stroke="' + a + '"/><rect x="28" y="84" width="200" height="132" rx="22" stroke="' + b + '"/></g>' +
        '<text x="128" y="172" text-anchor="middle" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900" font-size="58" letter-spacing="2" fill="' + t + '">IPTV</text>';
    } else if (name === 'ytmusic') {
      body = g + '<circle cx="128" cy="128" r="86" stroke="' + b + '"/><path d="M108 92 L170 128 L108 164 Z" stroke="' + a + '"/></g>';
    } else {
      body = g + '<path d="M104 186 V66 L196 46 V166" stroke="' + a + '"/><path d="M104 98 L196 78" stroke="' + a + '"/><ellipse cx="80" cy="190" rx="26" ry="20" stroke="' + b + '"/><ellipse cx="172" cy="170" rx="26" ry="20" stroke="' + b + '"/></g>';
    }
    return 'url("data:image/svg+xml,' + encodeURIComponent(head + body + '</svg>') + '")';
  }

  function renderIcons() {
    const cs = window.getComputedStyle(document.documentElement);
    const a = cs.getPropertyValue('--pink').trim();
    const b = cs.getPropertyValue('--cyan').trim();
    const t = cs.getPropertyValue('--ink').trim();
    ['iptv', 'ytmusic', 'applemusic'].forEach(id => {
      const img = document.querySelector('#' + id + ' img');
      if (img) {
        img.style.content = iconSvg(id, a, b, t);
      }
    });
  }

  function applyAccent() {
    const root = document.documentElement.style;
    if (cfg.accent) {
      const n = parseInt(cfg.accent.slice(1), 16);
      const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      root.setProperty('--pink', cfg.accent);
      root.setProperty('--pink-glow', rgba(cfg.accent, 0.35));
      root.setProperty('--line-pink', rgba(cfg.accent, 0.35));
      root.setProperty('--on-pink', lum > 0.62 ? '#1a0a20' : '#ffffff');
    } else {
      ['--pink', '--pink-glow', '--line-pink', '--on-pink'].forEach(p => root.removeProperty(p));
    }
    document.querySelectorAll('.dash-accent').forEach(b => {
      b.classList.toggle('active', (b.dataset.accent || '') === cfg.accent);
    });
    renderIcons();
  }

  function buildAccents() {
    const box = byId('dash-accents');
    box.textContent = '';
    ACCENTS.forEach(a => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dash-accent';
      b.dataset.accent = a[0];
      b.title = a[1];
      b.setAttribute('aria-label', a[1]);
      if (a[0]) {
        b.style.background = a[0];
      } else {
        b.classList.add('auto');
        b.innerHTML = '<em class="fas fa-magic"></em>';
      }
      b.addEventListener('click', () => {
        cfg.accent = a[0];
        save();
        applyAccent();
      });
      box.appendChild(b);
    });
  }

  // Android and iOS have a light and a dark look; "automatic" follows the system.
  function resolveTheme() {
    if (cfg.theme !== 'android' && cfg.theme !== 'ios') {
      return cfg.theme;
    }
    const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = cfg.mode === 'dark' || (cfg.mode === 'auto' && sysDark);
    return cfg.theme + '-' + (dark ? 'dark' : 'light');
  }

  function applyTheme() {
    document.documentElement.dataset.theme = resolveTheme();
    document.querySelectorAll('.dash-theme').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === cfg.theme);
    });
    document.querySelectorAll('.dash-mode').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === cfg.mode);
    });
    byId('dash-mode-row').classList.toggle('hidden', cfg.theme !== 'android' && cfg.theme !== 'ios');
    applyAccent();
    relayout();
  }

  // ---------- news (RSS in italiano) ----------

  const PROXY = 'https://api.rss2json.com/v1/api.json?rss_url=';
  const NEWS_SOURCES = {
    sky: { name: 'Sky TG24', url: 'https://tg24.sky.it/rss/tg24.xml' },
    ansa: { name: 'ANSA', url: 'https://www.ansa.it/sito/ansait_rss.xml' },
    corriere: { name: 'Corriere della Sera', url: 'https://xml2.corriereobjects.it/rss/homepage.xml', direct: true },
    repubblica: { name: 'la Repubblica', url: 'https://www.repubblica.it/rss/homepage/rss2.0.xml' },
    rai: { name: 'Rai News', url: 'https://www.rainews.it/rss/tutti' },
    google: { name: 'Google Notizie', url: 'https://news.google.com/rss?hl=it&gl=IT&ceid=IT:it' }
  };
  const NEWS_KEY = 'TeslaTheaterNews';
  const NEWS_TTL = 10 * 60 * 1000;
  let news = { source: '', items: [], at: 0 };
  let newsIndex = 0;

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
      newsIndex = 0;
      try {
        window.localStorage.setItem(NEWS_KEY, JSON.stringify(news));
      } catch (e) { /* ignore */ }
    }
    renderNews();
  }

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) {
      e.className = cls;
    }
    if (text != null) {
      e.textContent = text;
    }
    return e;
  }

  function picture(url, cls) {
    if (url) {
      const im = mk('img', cls);
      im.alt = '';
      im.src = url;
      im.onerror = () => { im.style.visibility = 'hidden'; };
      return im;
    }
    const ph = mk('span', cls + ' news-ph');
    ph.innerHTML = '<em class="fas fa-newspaper"></em>';
    return ph;
  }

  // A big story with its photo and three smaller ones; the set rotates by itself.
  function renderNews() {
    const items = (news.items || []).slice(0, 8);
    const src = NEWS_SOURCES[news.source] || NEWS_SOURCES[cfg.news];
    byId('news-chip').textContent = src.name;
    byId('news-age').textContent = items.length ? 'Aggiornato ' + ago(news.at) : 'Carico le notizie…';
    const main = byId('news-main');
    const more = byId('news-more');
    const dots = byId('news-dots');
    main.textContent = '';
    more.textContent = '';
    dots.textContent = '';
    if (!items.length) {
      return;
    }
    newsIndex = newsIndex % items.length;
    const first = items[newsIndex];
    const photo = !!first.img;
    byId('dash-news').classList.toggle('nophoto', !photo);
    if (photo) {
      main.appendChild(picture(first.img, 'news-photo'));
    }
    main.appendChild(mk('div', 'news-title', first.title));
    main.appendChild(mk('div', 'news-meta', ago(first.at)));
    const count = photo ? 3 : 5;
    for (let k = 1; k <= count && k < items.length; k++) {
      const it = items[(newsIndex + k) % items.length];
      const row = mk('div', 'news-row' + (it.img ? '' : ' nothumb'));
      if (it.img) {
        row.appendChild(picture(it.img, 'news-thumb'));
      }
      const txt = mk('div', 'news-row-text');
      txt.appendChild(mk('div', 'news-row-title', it.title));
      txt.appendChild(mk('div', 'news-meta', ago(it.at)));
      row.appendChild(txt);
      more.appendChild(row);
    }
    items.forEach((x, i) => dots.appendChild(mk('i', i === newsIndex ? 'on' : '')));
    // keep only the smaller stories that fit in the card
    while (more.children.length > 1 && more.scrollHeight > more.clientHeight + 1) {
      more.lastChild.remove();
    }
  }

  function rotateNews() {
    const card = byId('dash-news');
    if (document.hidden || byId('dash').offsetParent === null || !(news.items || []).length) {
      return;
    }
    card.classList.add('swap');
    setTimeout(() => {
      newsIndex += 1;
      renderNews();
      card.classList.remove('swap');
    }, 280);
  }
  // ---------- now playing (YouTube Music) ----------

  function music() {
    return window.musicApi || null;
  }

  function renderNow() {
    const m = music();
    const s = m ? m.state() : null;
    const has = !!(s && s.has);
    byId('dash-connect').classList.toggle('hidden', has);
    byId('dash-ctl').classList.toggle('hidden', !has);
    const cover = byId('dash-cover');
    if (has) {
      cover.classList.remove('empty');
      if (cover.dataset.id !== s.coverId) {
        cover.dataset.id = s.coverId;
        cover.onerror = () => {
          cover.onerror = null;
          cover.src = 'https://i.ytimg.com/vi/' + s.coverId + '/hqdefault.jpg';
        };
        cover.src = s.cover;
      }
    } else {
      cover.classList.add('empty');
      cover.dataset.id = '';
      if (cover.getAttribute('src') !== BLANK) {
        cover.src = BLANK;
      }
    }
    byId('dash-video').classList.toggle('hidden', !has);
    byId('dash-video').classList.toggle('active', !!s && !!s.video);
    byId('dash-left').textContent = has && s.duration ? '-' + Math.floor(Math.max(0, s.duration - s.progress) / 60) + ':' + String(Math.round(Math.max(0, s.duration - s.progress)) % 60).padStart(2, '0') : '';
    byId('dash-track').textContent = has ? s.title : 'Nessuna riproduzione';
    byId('dash-artist').textContent = has ? s.artist : 'Apri YouTube Music e scegli un brano.';
    byId('dash-prog').style.width = has && s.duration ? Math.min(100, (s.progress / s.duration) * 100) + '%' : '0%';
    if (!has) {
      return;
    }
    byId('dash-shuffle').classList.toggle('on', !!s.shuffle);
    byId('dash-repeat').classList.toggle('on', s.repeat !== 'off');
    byId('dash-repeat').title = s.repeat === 'one' ? 'Ripeti il brano' : s.repeat === 'all' ? 'Ripeti la playlist' : 'Ripeti';
    const icon = '<em class="fas fa-' + (s.playing ? 'pause' : 'play') + '"></em>';
    if (byId('dash-play').dataset.icon !== icon) {
      byId('dash-play').dataset.icon = icon;
      byId('dash-play').innerHTML = icon;
    }
    byId('dash-play').setAttribute('aria-label', s.playing ? 'Pausa' : 'Riproduci');
    if (m.place) {
      m.place();
    }
  }

  function bind() {
    byId('dash-video').addEventListener('click', e => {
      e.stopPropagation();
      if (music()) {
        music().toggleVideo();
        setTimeout(renderNow, 100);
      }
    });
    byId('dash-connect').addEventListener('click', () => {
      if (music()) {
        music().open();
      }
    });
    byId('dash-now').addEventListener('click', e => {
      if (e.target.closest('button') || !music()) {
        return;
      }
      music().open();
    });
    [['dash-play', 'toggle'], ['dash-next', 'next'], ['dash-prev', 'prev'], ['dash-shuffle', 'shuffle'], ['dash-repeat', 'repeat']].forEach(p => {
      byId(p[0]).addEventListener('click', e => {
        e.stopPropagation();
        if (music()) {
          music()[p[1]]();
          setTimeout(renderNow, 150);
        }
      });
    });
    byId('dash-settings-btn').addEventListener('click', () => {
      byId('dash-settings').classList.toggle('hidden');
      byId('dash-settings-btn').classList.toggle('active');
      relayout();
    });
    document.querySelectorAll('.dash-theme').forEach(b => {
      b.addEventListener('click', () => {
        cfg.theme = b.dataset.theme;
        save();
        applyTheme();
      });
    });
    document.querySelectorAll('.dash-mode').forEach(b => {
      b.addEventListener('click', () => {
        cfg.mode = b.dataset.mode;
        save();
        applyTheme();
      });
    });
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    }
    const sel = byId('dash-news-source');
    sel.value = cfg.news;
    sel.addEventListener('change', () => {
      cfg.news = sel.value;
      save();
      newsIndex = 0;
      news = { source: '', items: [], at: 0 };
      loadNews(true);
    });
  }

  function start() {
    if (started || !byId('dash')) {
      return;
    }
    started = true;
    load();
    bind();
    buildAccents();
    applyTheme();
    new MutationObserver(renderIcons).observe(byId('apps'), { childList: true });
    loadNews(false);
    setInterval(() => loadNews(true), NEWS_TTL);
    setInterval(rotateNews, 9000);
    let newsResize;
    window.addEventListener('resize', () => { clearTimeout(newsResize); newsResize = setTimeout(renderNews, 200); });
    renderNow();
    setInterval(renderNow, 1000);
    // The dashboard changes the header height, so the app tiles are sized again.
    setTimeout(relayout, 50);
    window.addEventListener('load', relayout);
  }

  window.dashReset = function () {
    try {
      window.localStorage.removeItem(KEY);
    } catch (e) { /* ignore */ }
    cfg.theme = 'ios';
    cfg.mode = 'auto';
    cfg.accent = '';
    cfg.news = 'sky';
    try {
      window.localStorage.removeItem(NEWS_KEY);
    } catch (e) { /* ignore */ }
    if (started) {
      applyTheme();
    }
  };

  // Apply the saved look before the first paint of the tiles.
  document.addEventListener('DOMContentLoaded', start);
}());
