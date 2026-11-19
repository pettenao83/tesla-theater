/*
 * Home widgets: live content inside the three quick-launch cards.
 *   YouTube        latest videos of your channels (tap = play in the home player)
 *   IPTV           favourite channels (or the first ones of the list) with logos
 *   YouTube Music  your first playlists (tap = start playing)
 */
(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  let filledAt = 0;

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

  function body(id) {
    return document.querySelector('.qw[data-id="' + id + '"] .qw-body');
  }

  function openTile(id) {
    const t = byId(id);
    if (t) {
      t.click();
    }
  }

  // empty state: one big button that opens the section
  function openButton(host, label, icon, id) {
    host.textContent = '';
    const b = el('button', 'qw-big');
    b.type = 'button';
    b.innerHTML = '<em class="' + icon + '"></em>';
    b.appendChild(el('span', null, label));
    b.addEventListener('click', () => openTile(id));
    host.appendChild(b);
  }

  // last tile of a list: opens the whole section
  function seeAll(host, id, label) {
    const b = el('button', 'qw-all');
    b.type = 'button';
    b.innerHTML = '<span></span><em class="fas fa-arrow-right"></em>';
    b.firstChild.textContent = label || 'Vedi tutti';
    b.addEventListener('click', () => openTile(id));
    host.appendChild(b);
  }

  function letter(name) {
    const s = el('span', 'qw-letter', (name || '?').trim().charAt(0).toUpperCase());
    return s;
  }

  async function fillYoutube() {
    const host = body('youtube');
    if (!host) {
      return;
    }
    host.textContent = '';
    host.appendChild(el('p', 'qw-note', 'Carico…'));
    try {
      if (!window.musicApi || !window.ytCard) {
        throw new Error('no api');
      }
      window.musicApi.init();
      if (!window.musicApi.loggedIn()) {
        throw new Error('login');
      }
      const list = await window.ytCard.shelf();
      if (!list.length) {
        throw new Error('empty');
      }
      host.textContent = '';
      list.slice(0, 3).forEach((v, i) => {
        const b = el('button', 'qw-thumb');
        b.type = 'button';
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = v.thumb;
        b.appendChild(img);
        b.appendChild(el('span', null, v.title));
        b.addEventListener('click', () => window.ytCard.start(list, i));
        host.appendChild(b);
      });
      seeAll(host, 'youtube');
    } catch (e) {
      openButton(host, 'Apri YouTube', 'fab fa-youtube', 'youtube');
    }
  }

  async function fillIptv() {
    const host = body('iptv');
    if (!host || typeof window.iptvQuick !== 'function') {
      return;
    }
    host.textContent = '';
    host.appendChild(el('p', 'qw-note', 'Carico…'));
    try {
      const q = await window.iptvQuick(4);
      if (!q.items.length) {
        throw new Error('empty');
      }
      const title = document.querySelector('.qw[data-id="iptv"] .qw-title small');
      if (title) {
        title.textContent = q.favorites ? 'Preferiti' : 'Canali';
      }
      host.textContent = '';
      const grid = el('div', 'qw-chans');
      q.items.forEach(c => {
        const b = el('button', 'qw-chan');
        b.type = 'button';
        b.title = c.name;
        const logo = el('span', 'qw-logo');
        if (c.logo) {
          const img = el('img');
          img.alt = '';
          img.loading = 'lazy';
          img.src = c.logo;
          img.onerror = () => {
            logo.textContent = '';
            logo.appendChild(letter(c.name));
          };
          logo.appendChild(img);
        } else {
          logo.appendChild(letter(c.name));
        }
        b.append(logo, el('span', 'qw-chan-name', c.name));
        b.addEventListener('click', () => window.iptvPlayUrl(c.url));
        grid.appendChild(b);
      });
      host.appendChild(grid);
      seeAll(host, 'iptv');
    } catch (e) {
      openButton(host, 'Apri IPTV', 'fas fa-tv', 'iptv');
    }
  }

  async function fillMusic() {
    const host = body('ytmusic');
    if (!host) {
      return;
    }
    host.textContent = '';
    host.appendChild(el('p', 'qw-note', 'Carico…'));
    try {
      if (!window.musicApi) {
        throw new Error('no api');
      }
      window.musicApi.init();
      if (!window.musicApi.loggedIn()) {
        throw new Error('login');
      }
      const pls = (await window.musicApi.playlists()).slice(0, 4);
      if (!pls.length) {
        throw new Error('empty');
      }
      host.textContent = '';
      pls.forEach(p => {
        const b = el('button', 'qw-pl');
        b.type = 'button';
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        if (p.thumb) {
          img.src = p.thumb;
        }
        const txt = el('span', 'qw-pl-text');
        txt.appendChild(el('b', null, p.title));
        b.append(img, txt, Object.assign(el('em', 'fas fa-play qw-pl-play'), {}));
        b.addEventListener('click', async () => {
          b.classList.add('busy');
          try {
            await window.musicApi.playPlaylist(p.id, p.title);
          } catch (e) { /* the player shows its own message */ }
          b.classList.remove('busy');
        });
        host.appendChild(b);
      });
      seeAll(host, 'ytmusic');
    } catch (e) {
      openButton(host, 'Apri YouTube Music', 'fas fa-music', 'ytmusic');
    }
  }

  window.fillQuickWidgets = function () {
    filledAt = Date.now();
    fillYoutube();
    fillIptv();
    fillMusic();
  };

  // coming back to the home after a while: refresh the content
  window.addEventListener('DOMContentLoaded', function () {
    const header = byId('app-header');
    if (!header) {
      return;
    }
    new MutationObserver(function () {
      if (!header.classList.contains('hidden') && Date.now() - filledAt > 90000) {
        window.fillQuickWidgets();
      }
    }).observe(header, { attributes: true, attributeFilter: ['class'] });
  });
}());
