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
  let mini = null;
  let miniMarker = null;
  let miniTiles = null;
  let miniOn = false;

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
    byId('pos-retry').classList.add('hidden');
    set('pos-lat', c.latitude.toFixed(6));
    set('pos-lon', c.longitude.toFixed(6));
    set('pos-acc', c.accuracy != null ? Math.round(c.accuracy) + ' m' : 'n.d.');
    set('pos-speed', c.speed != null && !isNaN(c.speed) ? Math.round(c.speed * 3.6) + ' km/h' : 'n.d.');
    set('pos-head', c.heading != null && !isNaN(c.heading) ? Math.round(c.heading) + '°' : 'n.d.');
    set('pos-alt', c.altitude != null ? Math.round(c.altitude) + ' m' : 'n.d.');
    set('pos-count', String(count));
    tickAge();
    updateMini(c);
    byId('pos-hud-speed').textContent = c.speed != null && !isNaN(c.speed) ? Math.round(c.speed * 3.6) : '0';
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

  function updateMini(c) {
    const kmh = c.speed != null && !isNaN(c.speed) ? Math.round(c.speed * 3.6) : 0;
    const chip = byId('dash-map-speed');
    chip.classList.remove('hidden');
    chip.firstElementChild.textContent = kmh;
    byId('dash-map-hint').classList.add('hidden');
    if (!mini || !window.L) {
      return;
    }
    const ll = [c.latitude, c.longitude];
    if (!miniMarker) {
      miniMarker = window.L.circleMarker(ll, { radius: 9, weight: 3, color: '#ffffff', fillColor: '#0a84ff', fillOpacity: 1 }).addTo(mini);
    } else {
      miniMarker.setLatLng(ll);
    }
    mini.setView(ll, 15, { animate: false });
  }

  async function startMini() {
    if (miniOn) {
      return;
    }
    miniOn = true;
    try {
      await loadLeaflet();
    } catch (e) {
      miniOn = false;
      return;
    }
    mini = window.L.map('dash-map-el', {
      zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false, attributionControl: true
    }).setView([45.49, 12.15], 15);
    miniTiles = window.L.tileLayer(tileUrl(), { maxZoom: 19, attribution: '© OSM' }).addTo(mini);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => mini.invalidateSize()).observe(byId('dash-map-el'));
    }
    if (last) {
      updateMini(last.coords);
    }
  }

  function initCard() {
    const card = byId('dash-map');
    if (!card) {
      return;
    }
    card.addEventListener('click', () => openPosition());
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        openPosition();
      }
    });
    // already allowed before: start straight away; otherwise wait for the first tap
    if (navigator.permissions && navigator.permissions.query && 'geolocation' in navigator) {
      navigator.permissions.query({ name: 'geolocation' }).then(p => {
        if (p.state === 'granted') {
          startMini();
          start();
        }
      }).catch(() => {});
    }
  }

  function onError(e) {
    const text = {
      1: 'Il browser ha negato la posizione (permesso rifiutato o non disponibile in questo browser).',
      2: 'Posizione non disponibile: il dispositivo non riesce a determinarla.',
      3: 'Tempo scaduto: nessuna posizione ricevuta in 20 secondi.'
    }[e.code] || 'Errore di posizione.';
    status(text + (e.message ? ' (' + e.message + ')' : ''), 'error');
    byId('pos-info').classList.remove('hidden');
    byId('pos-retry').classList.remove('hidden');
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
      return;
    }
    status('Richiedo la posizione… (se compare un avviso, consenti)', 'wait');
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000
    });
  }

  function stop() { /* the watch keeps running for the home card */ }

  let routeLine = null;
  let destMarker = null;
  let dest = null;

  function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
  }

  function fmtTime(s) {
    const m = Math.round(s / 60);
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
  }

  function clearRoute() {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
    dest = null;
    byId('pos-route').classList.add('hidden');
  }

  async function routeTo(lat, lon, name) {
    byId('pos-results').classList.add('hidden');
    if (!last) {
      status('Serve prima la posizione attuale per calcolare il percorso.', 'error');
      byId('pos-info').classList.remove('hidden');
      return;
    }
    await ensureMap();
    clearRoute();
    dest = { lat: lat, lon: lon };
    const c = last.coords;
    try {
      const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + c.longitude + ',' + c.latitude + ';' + lon + ',' + lat + '?overview=full&geometries=geojson');
      const j = await r.json();
      const rt = j.routes && j.routes[0];
      if (!rt) { throw new Error('nessun percorso'); }
      routeLine = window.L.geoJSON(rt.geometry, { style: { color: '#0a84ff', weight: 7, opacity: 0.9 } }).addTo(map);
      destMarker = window.L.circleMarker([lat, lon], { radius: 9, weight: 3, color: '#fff', fillColor: '#ff453a', fillOpacity: 1 }).addTo(map);
      follow = false;
      byId('pos-follow').classList.remove('active');
      map.fitBounds(routeLine.getBounds(), { padding: [80, 80] });
      byId('pos-route-eta').textContent = fmtTime(rt.duration);
      byId('pos-route-dist').textContent = fmtDist(rt.distance);
      byId('pos-route-name').textContent = name;
      byId('pos-route').classList.remove('hidden');
    } catch (e) {
      status('Percorso non disponibile (' + e.message + ').', 'error');
      byId('pos-info').classList.remove('hidden');
    }
  }

  async function search(q) {
    const list = byId('pos-results');
    list.innerHTML = '<li>Cerco…</li>';
    list.classList.remove('hidden');
    try {
      let u = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=it&q=' + encodeURIComponent(q);
      if (last) {
        const c = last.coords;
        u += '&viewbox=' + (c.longitude - 1) + ',' + (c.latitude + 1) + ',' + (c.longitude + 1) + ',' + (c.latitude - 1);
      }
      const res = await (await fetch(u)).json();
      list.innerHTML = '';
      if (!res.length) {
        list.innerHTML = '<li>Nessun risultato</li>';
        return;
      }
      res.forEach(p => {
        const li = document.createElement('li');
        li.textContent = p.display_name;
        li.addEventListener('click', () => routeTo(parseFloat(p.lat), parseFloat(p.lon), p.display_name.split(',')[0]));
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '<li>Ricerca non disponibile</li>';
    }
  }

  function bind() {
    if (bound) {
      return;
    }
    bound = true;
    byId('pos-form').addEventListener('submit', e => {
      e.preventDefault();
      const q = byId('pos-q').value.trim();
      if (q) { search(q); }
    });
    byId('pos-info-btn').addEventListener('click', () => byId('pos-info').classList.toggle('hidden'));
    byId('pos-route-clear').addEventListener('click', () => { if (map) { clearRoute(); } });
    byId('pos-route-open').addEventListener('click', () => {
      if (dest) {
        window.open('https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + dest.lat + ',' + dest.lon, '_blank');
      }
    });
    byId('pos-home').addEventListener('click', closePosition);
    byId('pos-retry').addEventListener('click', () => {
      count = 0;
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
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
    startMini();
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
    if (mini) {
      setTimeout(() => mini.invalidateSize(), 100);
    }
  }

  window.openPosition = openPosition;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCard);
  } else {
    initCard();
  }
}());
