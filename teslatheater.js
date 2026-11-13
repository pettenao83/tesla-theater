const DEFAULT_SITES = {
  "netflix": { "name": "Netflix", "img": "images/netflix.png", "url": "https://www.netflix.com/" },
  "youtube": { "name": "YouTube", "img": "images/youtube.png", "url": "https://www.youtube.com/" },
  "iptv": { "name": "IPTV", "img": "images/iptv.svg", "url": "#iptv", "internal": "iptv" },
  "ytmusic": { "name": "YouTube Music", "img": "images/ytmusic.svg", "url": "#music", "internal": "music" },
  "applemusic": { "name": "Apple Music", "img": "images/applemusic.svg", "url": "https://music.apple.com/" },
  "primevideo": { "name": "Prime Video", "img": "images/primevideo.png", "url": "https://www.primevideo.com/" },
  "plex": { "name": "Plex", "img": "images/plex.png", "url": "https://app.plex.tv/" },
  "disneyplus": { "name": "Disney+", "img": "images/disneyplus.png", "url": "https://www.disneyplus.com/" },
  "nowtv": { "name": "NOW TV", "img": "images/nowtv.png", "url": "https://www.nowtv.com/" },
  "dazn": { "name": "DaZn", "img": "images/dazn.png", "url": "https://www.dazn.com/" },
  "paramountplus": { "name": "Paramount+", "img": "images/paramountplus.png", "url": "https://www.paramountplus.com/" },
  "discoveryplus": { "name": "Discovery+", "img": "images/discoveryplus.png", "url": "https://www.discoveryplus.com/" },
  "twitch": { "name": "Twitch", "img": "images/twitch.png", "url": "https://www.twitch.tv/" },
  "raiplay": { "name": "Rai Play", "img": "images/raiplay.png", "url": "https://www.raiplay.it/" },
  "mediaset": { "name": "Mediaset", "img": "images/mediaset.png", "url": "https://www.mediasetplay.mediaset.it/" },
  "skytg24": { "name": "Sky TG24", "img": "images/skytg24.png", "url": "https://tg24.sky.it/" },
  "airtesla": { "name": "Air Tesla", "img": "images/airtesla.png", "url": "http://6.6.6.6/" }
};

function loadCustomSites() {
  let stored = window.localStorage.getItem('TeslaTheaterCustomSites');
  return stored ? JSON.parse(stored) : {};
}

function saveCustomSites(customSites) {
  window.localStorage.setItem('TeslaTheaterCustomSites', JSON.stringify(customSites));
}

function loadSites(callback) {
  const sites = { ...DEFAULT_SITES, ...loadCustomSites() };
  callback(sites);
}

function addCustomApp(name, url, imgData) {
  if (!name || !url) {
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  const id = 'custom-' + Date.now();
  const customSites = loadCustomSites();
  customSites[id] = { name: name, url: url, img: imgData || null, custom: true };
  saveCustomSites(customSites);
  loadSites(sites => buildPage(sites));
}

function removeCustomApp(id) {
  const customSites = loadCustomSites();
  delete customSites[id];
  saveCustomSites(customSites);
  if (appsStatus['order']) {
    appsStatus['order'] = appsStatus['order'].filter(existingId => existingId !== id);
  }
  if (appsStatus['removed']) {
    appsStatus['removed'] = appsStatus['removed'].filter(existingId => existingId !== id);
  }
  loadSites(sites => buildPage(sites));
}

// Permanently removes a default (non-custom) site from the visible list.
function removeDefaultSite(id) {
  if (!appsStatus['removed']) {
    appsStatus['removed'] = [];
  }
  if (!appsStatus['removed'].includes(id)) {
    appsStatus['removed'].push(id);
  }
  if (appsStatus['order']) {
    appsStatus['order'] = appsStatus['order'].filter(existingId => existingId !== id);
  }
  storeStatus($('#apps'));
  loadSites(sites => buildPage(sites));
}

function open() {
  if (onEdit) {
    return;
  }

  // remember the last apps opened (shown in the "recent" tile of the home)
  try {
    const rid = $(this).attr('id');
    let recent = JSON.parse(window.localStorage.getItem('TeslaTheaterRecent') || '[]');
    recent = [rid].concat(recent.filter(x => x !== rid)).slice(0, 3);
    window.localStorage.setItem('TeslaTheaterRecent', JSON.stringify(recent));
  } catch (e) { /* ignore */ }

  // Built-in pages (e.g. the IPTV player) open inside the launcher itself.
  if ($(this).attr('data-internal') === 'iptv' && typeof openIptv === 'function') {
    openIptv();
    return;
  }
  if ($(this).attr('data-internal') === 'music' && typeof openMusic === 'function') {
    openMusic();
    return;
  }

  var link = $(this).attr('link');
  let siteId = $(this).attr('id');
  gtag('event', `open-${siteId}`, {
    siteId: siteId,
    siteUrl: link,
    mode: fullscreen ? "same-window" : "fullscreen"
  });

  if (fullscreen) {
    window.location.href = link;
  } else {
    window.location.href = 'https://www.youtube.com/redirect?q='+link;
  }
}

function openFullScreen() {
  if (onEdit) {
    return;
  }

  gtag('event', 'open-fullscreen', {
    siteId: 'TeslaTheater',
    siteUrl: window.location.href,
    mode: "fullscreen"
  });
  window.location.href = 'https://www.youtube.com/redirect?q='+window.location.href+'?mode=fullscreen';
}

function buildPage(sites) {
  const $apps = $('#apps');

  loadStatus();

  $apps.children('.button').remove();

  const $template = $($('#site-template').html());

  // Drop sites the user has removed for good.
  if (appsStatus['removed']) {
    for (const removedId of appsStatus['removed']) {
      delete sites[removedId];
    }
  }

  // Add the sites from sorted list
  if (appsStatus['order']) {
    for (const siteId of appsStatus['order']) {
      let site = sites[siteId];
      if (site) {
        addSiteButton($template, siteId, sites[siteId], $apps);
        delete sites[siteId];
      }
    }
  }

  for (const siteId in sites) {
    addSiteButton($template, siteId, sites[siteId], $apps);
  }

  $('.button').on('click', open);
  $('.deleteswitch').on('click', function(e) {
    e.stopPropagation();
    if (!onEdit) {
      return;
    }
    const id = $(this).attr('for');
    if ($(this).closest('.button').hasClass('custom-app')) {
      removeCustomApp(id);
    } else {
      removeDefaultSite(id);
    }
  });

  setTimeout(() => storeStatus($apps), 1000);

  $apps.sortable({
    placeholder: 'button highlight',
    update: function(event, ui) {
      storeStatus($(this));
    }});

  editMode(onEdit);
  resizeTiles();
}

// Home, music and IPTV are laid out on a virtual page of fixed height (820px) whose width
// follows the window only between 1.3:1 and 1.9:1. The page is then scaled to fit: it never
// rearranges or overflows, whatever the size of the window; outside those proportions it is
// centred with empty bands.
function fitHome() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const H = 820;
  const aspect = Math.min(1.9, Math.max(1.3, vw / vh));
  const W = Math.round(H * aspect);
  const z = Math.min(vw / W, vh / H);
  // "1vh" of the virtual page: constant, so every size that uses it is stable
  document.documentElement.style.setProperty('--vh', (H / 100) + 'px');
  ['app-header', 'spotify-view', 'iptv-view'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) {
      return;
    }
    el.style.position = 'fixed';
    el.style.left = Math.round((vw - W * z) / 2) + 'px';
    el.style.top = Math.round((vh - H * z) / 2) + 'px';
    el.style.width = W + 'px';
    el.style.height = H + 'px';
    el.style.maxWidth = 'none';
    el.style.margin = '0';
    el.style.transformOrigin = '0 0';
    el.style.transform = 'scale(' + z + ')';
  });
}

function resizeTiles() {
  fitHome();
  const $apps = $('#apps');
  const el = $apps[0];
  const n = $apps.children('.button').length;
  if (!el || !n) {
    return;
  }
  const W = el.clientWidth;
  const H = el.clientHeight;
  if (W <= 0 || H <= 0) {
    return; // the home is hidden (another page is open)
  }
  // One column. The tiles are as large as the column allows; when they all fit, the leftover
  // height is shared evenly between them; with many apps they shrink down to a minimum size
  // and, only after that, the column scrolls.
  const pad = 10;
  const gapMin = 8;
  const minSize = 70;
  const widthSize = Math.min(160, W - pad * 2);
  const fit = (H - pad * 2 - (n - 1) * gapMin) / n;
  let size;
  let gap;
  let scroll = false;
  if (fit >= widthSize) {
    size = Math.floor(widthSize);
    gap = n > 1 ? Math.min(size * 0.5, (H - pad * 2 - n * size) / (n - 1)) : 0;
  } else if (fit >= minSize) {
    size = Math.floor(fit);
    gap = gapMin;
  } else {
    size = Math.floor(Math.min(160, W - pad * 2 - 14));
    gap = 10;
    scroll = true;
  }
  el.style.overflowY = scroll ? 'auto' : 'hidden';
  el.style.padding = pad + 'px';
  el.style.gridTemplateColumns = `${size}px`;
  el.style.columnGap = '0';
  el.style.rowGap = `${Math.round(gap)}px`;
  el.style.justifyContent = 'center';
  el.style.alignContent = scroll ? 'start' : 'center';
  document.documentElement.style.setProperty('--tile-size', `${size}px`);
  $apps.children('.button').css('margin-left', '');
}

let resizeTimer;
$(window).on('resize', function() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeTiles, 120);
});

function loadStatus() {
  let storage = window.localStorage.getItem('TeslaTheaterStatus');
  let cookie = getCookie('TeslaTheaterStatus');

  if (storage) {
    appsStatus = JSON.parse(storage);
  } else if (cookie) {
    appsStatus = cookie;
  } else {
    appsStatus = {};
  }

  console.log(`Loaded status (s:${storage!=undefined?'y':'n'}, c:${cookie!=undefined?'y':'n'}): ${JSON.stringify(appsStatus)}`);

  setCookie('TeslaTheaterStatus', appsStatus); // update cookie expiration every time
}

function storeStatus($apps) {
  appsStatus['order'] = $apps.sortable('toArray');
  setCookie('TeslaTheaterStatus', appsStatus);
  window.localStorage.setItem('TeslaTheaterStatus', JSON.stringify(appsStatus));
}

function addSiteButton($template, siteId, site, $apps) {
  const $app = $template.clone();
  $app.attr('id', siteId);
  $app.attr('link', site.url);
  $app.attr('title', site.name);
  if (site.internal) {
    $app.attr('data-internal', site.internal);
  }
  $app.find('.deleteswitch').attr('for', siteId);

  if (site.img) {
    $app.find('img').attr('src', site.img.startsWith('http') || site.img.startsWith('data:') ? site.img : `images/${site.img.replace(/^images\//, '')}`).attr('alt', site.name);
  } else {
    $app.find('.logo-container').html(`<span class="logo-fallback">${site.name.charAt(0).toUpperCase()}</span>`);
    $app.find('.logo-container').attr('title', site.name);
  }

  if (site.custom) {
    $app.addClass('custom-app');
  }

  $app.appendTo($apps);
}

function queryparam(key) {
  var match = window.location.search.match(new RegExp('[?&]'+key+'=([^&]+)(&|$)'));
  return match && decodeURIComponent(match[1].replace(/\+/g, ' '));
}

function setCookie(cname, cvalue) {
  if (cvalue) {
    const d = new Date();
    d.setTime(d.getTime() + (10 * 365 * 24 * 60 * 60 * 1000));
    let expires = 'expires='+d.toUTCString();
    document.cookie = cname + '=' + JSON.stringify(cvalue) + ';' + expires + ';path=/';
    console.log(document.cookie);
  }
}

function getCookie(cname, cdefvalue) {
  let name = cname + '=';
  let ca = document.cookie.split(';');
  let cvalue=cdefvalue;
  for(const c of ca) {
    var cookie = c.trim();
    if (cookie.indexOf(name) == 0) {
      let value = cookie.substring(name.length, cookie.length);
      if (value) {
        cvalue = JSON.parse(value);
      }
    }
  }
  return cvalue;
}

var fullscreen=false;
var appsStatus;
var onEdit = false;
var uploadedImgData = null;
var zoomFactor = parseFloat(window.localStorage.getItem('TeslaTheaterZoom')) || 1;

function resetAddAppForm() {
  $('#add-app-name').val('');
  $('#add-app-url').val('');
  $('#add-app-img-file').val('');
  $('#add-app-error').addClass('hidden');
  uploadedImgData = null;
  $('#add-app-img-preview').addClass('hidden');
  $('#add-app-img-preview img').attr('src', '');
  $('#add-app-img-placeholder').removeClass('hidden');
}

// --- Access lock ---------------------------------------------------------
// Client-side only: this hides the launcher behind a shared PIN so a casual
// visitor with the link can't poke at it. It is NOT real security (anyone
// reading the page source can see the hash and brute-force it offline).
const AUTH_HASH = '995829d2ff8904951c4e0b113280005885ae78db04a41741014a9a379290ef85';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isUnlocked() {
  return window.localStorage.getItem('TeslaTheaterAuth') === '1';
}

function showApp() {
  $('#lock-screen').addClass('hidden');
  $('#app-root').removeClass('hidden');
}

function showLock() {
  $('#app-root').addClass('hidden');
  $('#lock-screen').removeClass('hidden');
  $('#lock-error').addClass('hidden');
  $('#lock-pin').val('').focus();
}

function lockSite() {
  window.localStorage.removeItem('TeslaTheaterAuth');
  showLock();
}

function resetDefaults() {
  if (!window.confirm("Ripristinare le impostazioni predefinite? L'ordine, le app aggiunte/rimosse, lo zoom e le liste IPTV personalizzati andranno persi.")) {
    return;
  }
  window.localStorage.removeItem('TeslaTheaterStatus');
  window.localStorage.removeItem('TeslaTheaterCustomSites');
  window.localStorage.removeItem('TeslaTheaterZoom');
  window.localStorage.removeItem('TeslaTheaterIptv');
  if (typeof iptvReset === 'function') {
    iptvReset();
  }
  if (typeof musicReset === 'function') {
    musicReset();
  }
  if (typeof dashReset === 'function') {
    dashReset();
  }
  document.cookie = 'TeslaTheaterStatus=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
  zoomFactor = 1;
  $('#zoom-slider').val(1);
  loadSites(sites => buildPage(sites));
}

// --- Cross-browser config export/import ----------------------------------
// This is a static site with no shared backend: each browser keeps its own
// localStorage, so settings don't sync between devices/browsers on their
// own. These let you carry your configuration over manually.
function exportSettings() {
  const data = {
    status: window.localStorage.getItem('TeslaTheaterStatus'),
    customSites: window.localStorage.getItem('TeslaTheaterCustomSites'),
    zoom: window.localStorage.getItem('TeslaTheaterZoom'),
    iptv: typeof iptvExportData === 'function' ? iptvExportData() : null
  };
  const code = window.btoa(unescape(encodeURIComponent(JSON.stringify(data))));

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => {
      window.alert('Configurazione copiata negli appunti. Incollala nell\'altro browser con "Importa".');
    }).catch(() => {
      window.prompt('Copia questo codice e incollalo nell\'altro browser con "Importa":', code);
    });
  } else {
    window.prompt('Copia questo codice e incollalo nell\'altro browser con "Importa":', code);
  }
}

function importSettings() {
  const code = window.prompt('Incolla qui il codice di configurazione esportato dall\'altro browser:');
  if (!code) {
    return;
  }
  try {
    const data = JSON.parse(decodeURIComponent(escape(window.atob(code.trim()))));
    if (data.status) {
      window.localStorage.setItem('TeslaTheaterStatus', data.status);
    }
    if (data.customSites) {
      window.localStorage.setItem('TeslaTheaterCustomSites', data.customSites);
    }
    if (data.zoom) {
      window.localStorage.setItem('TeslaTheaterZoom', data.zoom);
    }
    if (data.iptv) {
      window.localStorage.setItem('TeslaTheaterIptv', data.iptv);
    }
    window.alert('Configurazione importata.');
    window.location.reload();
  } catch (e) {
    window.alert('Codice non valido: controlla di averlo copiato per intero.');
  }
}

function initApp() {
  gtag('config', 'GA_MEASUREMENT_ID', { 'transport_type': 'beacon'});

  const mode = queryparam('mode');
  if (mode == 'fullscreen') {
    fullscreen=true;
    $('#fullscreen').addClass('hidden');
  }

  $('#zoom-slider').val(zoomFactor);
  loadSites(sites => buildPage(sites));

  if (!fullscreen) {
    $('#fullscreen').on('click', openFullScreen);
  }

  $('#zoom-slider').on('input', function() {
    zoomFactor = parseFloat($(this).val());
    window.localStorage.setItem('TeslaTheaterZoom', zoomFactor);
    resizeTiles();
  });

  $('#reset-defaults-btn').on('click', resetDefaults);
  $('#lock-btn').on('click', lockSite);
  $('#export-btn').on('click', exportSettings);
  $('#import-btn').on('click', importSettings);

  $('#add-app-btn').on('click', function() {
    const willShow = $('#add-app-form').hasClass('hidden');
    $('#add-app-form').toggleClass('hidden', !willShow);
    $(this).toggleClass('active', willShow);
    if (onEdit) {
      $('#remove-app-btn').removeClass('active');
      editMode(false);
    }
    if (willShow) {
      resetAddAppForm();
    }
  });

  $('#add-app-cancel').on('click', function() {
    $('#add-app-form').addClass('hidden');
    $('#add-app-btn').removeClass('active');
    resetAddAppForm();
  });

  $('#remove-app-btn').on('click', function() {
    const newEdit = !onEdit;
    if (newEdit) {
      $('#add-app-form').addClass('hidden');
      $('#add-app-btn').removeClass('active');
    }
    $(this).toggleClass('active', newEdit);
    editMode(newEdit);
  });

  $('#add-app-img-file').on('change', function(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = function(ev) {
      uploadedImgData = ev.target.result;
      $('#add-app-img-preview img').attr('src', uploadedImgData);
      $('#add-app-img-preview').removeClass('hidden');
      $('#add-app-img-placeholder').addClass('hidden');
    };
    reader.readAsDataURL(file);
  });

  $('#add-app-submit').on('click', function() {
    const name = $('#add-app-name').val().trim();
    const url = $('#add-app-url').val().trim();
    if (!name || !url) {
      $('#add-app-error').text('Inserisci nome e indirizzo.').removeClass('hidden');
      return;
    }
    $('#add-app-error').addClass('hidden');
    addCustomApp(name, url, uploadedImgData);
    $('#add-app-form').addClass('hidden');
    $('#add-app-btn').removeClass('active');
    resetAddAppForm();
  });
}

$(function() {
  $('#lock-form').on('submit', async function(e) {
    e.preventDefault();
    const pin = $('#lock-pin').val();
    const hash = await sha256Hex(pin);
    if (hash === AUTH_HASH) {
      window.localStorage.setItem('TeslaTheaterAuth', '1');
      showApp();
      resizeTiles();
    } else {
      $('#lock-error').removeClass('hidden');
      $('#lock-pin').val('').focus();
    }
  });

  if (isUnlocked()) {
    showApp();
  } else {
    showLock();
  }

  initApp();
});

function editMode(edit) {
  onEdit = edit;
  $('.deleteswitch').toggleClass('hidden', !edit);
  if (edit) {
    $('.button.active').removeClass('active');
  } else {
    $('.button').addClass('active');
  }
}
