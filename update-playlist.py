#!/usr/bin/env python3
"""Rigenera playlists/italia.m3u: scarica le fonti, tiene solo i canali https
raggiungibili da una pagina web (risposta valida + CORS aperto) e toglie i doppioni.

Uso:   python3 update-playlist.py
Poi:   git add playlists/italia.m3u && git commit -m "Aggiorna lista" && git push
"""
import re, subprocess, tempfile, os, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'playlists', 'italia.m3u')
ORIGIN = 'https://pettenao83.github.io'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
# (indirizzo, gruppo da tenere o None per tutti), in ordine di priorità
SOURCES = [
    ('https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', 'Italy'),
    ('https://iptv-org.github.io/iptv/countries/it.m3u', None),
    ('https://raw.githubusercontent.com/Tundrak/IPTV-Italia/main/iptvitaplus.m3u', None),
]

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    return urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'ignore')

def attr(line, a):
    m = re.search(a + r'="([^"]*)"', line)
    return m.group(1) if m else ''

def norm(name):
    name = re.sub(r'[ⒼⓈ]|\(.*?\)|\bhd\b', '', name.lower())
    return re.sub(r'[^a-z0-9]', '', name)

def parse(text, only_group):
    lines = text.splitlines()
    for k, l in enumerate(lines):
        if not l.startswith('#EXTINF'):
            continue
        g = attr(l, 'group-title')
        if only_group and g != only_group:
            continue
        url = next((x.strip() for x in lines[k + 1:] if x.strip() and not x.startswith('#')), None)
        if not url or not url.startswith('https://'):
            continue
        name = re.sub(r'\s*[ⒼⓈ]\s*', '', l.rsplit(',', 1)[-1]).strip()
        yield dict(name=name, url=url, logo=attr(l, 'tvg-logo'), group=g)

def reachable(row):
    fd, path = tempfile.mkstemp()
    os.close(fd)
    try:
        p = subprocess.run(['curl', '-s', '-m', '10', '-D', '-', '-o', path, '-r', '0-2000',
                            '-H', 'Origin: ' + ORIGIN, '-A', UA, row['url']],
                           capture_output=True, text=True)
        head = p.stdout.replace('\r', '')
        codes = re.findall(r'^HTTP\S* (\d+)', head, re.M)
        acao = [x.split(':', 1)[1].strip() for x in head.split('\n')
                if x.lower().startswith('access-control-allow-origin')]
        body = open(path, errors='ignore').read(300)
    finally:
        os.remove(path)
    ok = bool(codes) and int(codes[-1]) < 400 and bool(acao) and acao[-1] in ('*', ORIGIN)
    if ok and re.search(r'\.m3u8?(\?|$)', row['url']) and '#EXTM3U' not in body:
        ok = False
    return ok

def main():
    rows = []
    for url, grp in SOURCES:
        try:
            rows += list(parse(fetch(url), grp))
        except Exception as e:
            print('fonte non raggiungibile:', url, e)
    seen, uniq = set(), []
    for r in rows:
        if r['url'] not in seen:
            seen.add(r['url'])
            uniq.append(r)
    print('candidati https:', len(uniq))
    with ThreadPoolExecutor(24) as ex:
        ok = list(ex.map(reachable, uniq))
    good = [r for r, o in zip(uniq, ok) if o]
    names, out = set(), []
    for r in good:
        k = norm(r['name'])
        if k not in names:
            names.add(k)
            out.append(r)
    if len(out) < 100:
        raise SystemExit('Troppo pochi canali (%d): non sovrascrivo il file.' % len(out))
    out.sort(key=lambda r: r['name'].lower())
    with open(OUT, 'w') as f:
        f.write('#EXTM3U\n')
        for r in out:
            logo = ' tvg-logo="%s"' % r['logo'] if r['logo'].startswith('http') else ''
            grp = r['group'] if r['group'] and r['group'] != 'Italy' else 'Italia'
            f.write('#EXTINF:-1%s group-title="%s",%s\n%s\n' % (logo, grp, r['name'], r['url']))
    print('raggiungibili: %d, dopo i doppioni: %d -> %s' % (len(good), len(out), OUT))

if __name__ == '__main__':
    main()
