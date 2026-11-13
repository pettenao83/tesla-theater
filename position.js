/*
 * Position test: shows whether the browser (e.g. the Tesla's) gives us the real-time position,
 * with every value it reports and a live map (Leaflet + free CARTO / OpenStreetMap tiles).
 */
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
  let watchId = null;
  let map = null;
  let marker = null;
  let circle = null;
  let tiles = null;
  let follow = true;
  let count = 0;
  let last = null;
  let leafletPromise = null;
  let ageTimer = null;
  let bound = false;

  function loadLeaflet() {
    if (window.L) {
      return Promise.resolve();
    }
    if (!leafletPromise) {
      leafletPromise = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = LEAFLET + 'leaflet.css';
        document.head.appendChild(css);
        const s = document.createElement('script');
        s.src = LEAFLET + 'leaflet.js';
        s.onload = resolve;
        s.onerror = () => {
          leafletPromise = null;
          reject(new Error('Mappa non raggiungibile'));
        };
        document.head.appendChild(s);
      });
    }
    return leafletPromise;
  }

  function set(id, text) {
    byId(id).textContent = text;
  }

  function status(text, kind) {
    const s = byId('pos-status');
    s.textContent = text;
    s.className = 'pos-status' + (kind ? ' ' + kind : '');
  }

  function tileUrl() {
    return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  }

  async function ensureMap() {
    try {
      await loadLeaflet();
    } catch (e) {
      byId('pos-map').textContent = 'Mappa non disponibile (rete).';
      return;
    }
    if (map) {
      return;
    }
    map = window.L.map('pos-map', { zoomControl: true, attributionControl: true }).setView([45.49, 12.15], 15);
    tiles = window.L.tileLayer(tileUrl(), {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);
    map.on('dragstart', () => {
      follow = false;
      byId('pos-follow').classList.remove('active');
    });
  }

  function onPosition(pos) {
    count += 1;
    last = pos;
    const c = pos.coords;
    status('Posizione ricevuta', 'ok');
    set('pos-lat', c.latitude.toFixed(6));
    set('pos-lon', c.longitude.toFixed(6));
    set('pos-acc', c.accuracy != null ? Math.round(c.accuracy) + ' m' : 'n.d.');
    set('pos-speed', c.speed != null && !isNaN(c.speed) ? Math.round(c.speed * 3.6) + ' km/h' : 'n.d.');
    set('pos-head', c.heading != null && !isNaN(c.heading) ? Math.round(c.heading) + '°' : 'n.d.');
    set('pos-alt', c.altitude != null ? Math.round(c.altitude) + ' m' : 'n.d.');
    set('pos-count', String(count));
    tickAge();
    if (map && window.L) {
      const ll = [c.latitude, c.longitude];
      if (!marker) {
        marker = window.L.circleMarker(ll, { radius: 9, weight: 3, color: '#ffffff', fillColor: '#0a84ff', fillOpacity: 1 }).addTo(map);
        circle = window.L.circle(ll, { radius: c.accuracy || 20, weight: 1, color: '#0a84ff', fillOpacity: 0.12 }).addTo(map);
      } else {
        marker.setLatLng(ll);
        circle.setLatLng(ll);
        circle.setRadius(c.accuracy || 20);
      }
      if (follow) {
        map.setView(ll, Math.max(map.getZoom(), 15));
      }
    }
  }

  function onError(e) {
    const text = {
      1: 'Il browser ha negato la posizione (permesso rifiutato o non disponibile in questo browser).',
      2: 'Posizione non disponibile: il dispositivo non riesce a determinarla.',
      3: 'Tempo scaduto: nessuna posizione ricevuta in 20 secondi.'
    }[e.code] || 'Errore di posizione.';
    status(text + (e.message ? ' (' + e.message + ')' : ''), 'error');
  }

  function tickAge() {
    if (!last) {
      set('pos-age', 'mai');
      return;
    }
    const s = Math.max(0, Math.round((Date.now() - last.timestamp) / 1000));
    set('pos-age', s < 2 ? 'adesso' : s + ' s fa');
  }

  function start() {
    set('pos-secure', window.isSecureContext ? 'sì (https)' : 'no');
    if (!('geolocation' in navigator)) {
      status('Questo browser non offre la geolocalizzazione.', 'error');
      return;
    }
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(p => {
        const label = { granted: 'consentito', denied: 'negato', prompt: 'da chiedere' }[p.state] || p.state;
        set('pos-perm', label);
        p.onchange = () => set('pos-perm', { granted: 'consentito', denied: 'negato', prompt: 'da chiedere' }[p.state] || p.state);
      }).catch(() => set('pos-perm', 'n.d.'));
    } else {
      set('pos-perm', 'n.d.');
    }
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
    }
    status('Richiedo la posizione… (se compare un avviso, consenti)', 'wait');
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000
    });
  }

  function stop() {
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
  }

  function bind() {
    if (bound) {
      return;
    }
    bound = true;
    byId('pos-home').addEventListener('click', closePosition);
    byId('pos-retry').addEventListener('click', () => {
      count = 0;
      start();
    });
    byId('pos-follow').addEventListener('click', () => {
      follow = !follow;
      byId('pos-follow').classList.toggle('active', follow);
      if (follow && marker && map) {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
      }
    });
  }

  async function openPosition() {
    bind();
    $('#app-header, #apps, #add-app-form').addClass('hidden');
    byId('iptv-view').classList.add('hidden');
    byId('spotify-view').classList.add('hidden');
    byId('app-root').classList.remove('hidden');
    byId('pos-view').classList.remove('hidden');
    follow = true;
    byId('pos-follow').classList.add('active');
    start();
    clearInterval(ageTimer);
    ageTimer = setInterval(tickAge, 1000);
    await ensureMap();
    if (map) {
      setTimeout(() => map.invalidateSize(), 150);
    }
  }

  function closePosition() {
    stop();
    clearInterval(ageTimer);
    byId('pos-view').classList.add('hidden');
    $('#app-header, #apps').removeClass('hidden');
    if (typeof resizeTiles === 'function') {
      resizeTiles();
    }
  }

  window.openPosition = openPosition;
}());
