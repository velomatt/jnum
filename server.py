"""jnum server: serves the drill page and spoken numbers from a VOICEVOX engine.

Synthesis is slow on the NAS (~20 s per clip), so a background worker keeps
generating clips into the cache, and /api/next hands out ready ones.

Standard library only. Configuration via environment variables:
  VOICEVOX_URL  engine base URL                 (default http://voicevox:50021)
  VOICES        comma-separated style ids       (default 2,8,11,13)
  CACHE_DIR     where synthesized WAVs go       (default /cache)
  STOCK_CAP     stop pre-generating at N clips  (default 20000; 0 disables the worker)
  PORT          listen port                     (default 8080)
"""
import json
import os
import random
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VOICEVOX_URL = os.environ.get('VOICEVOX_URL', 'http://voicevox:50021').rstrip('/')
VOICES = [int(v) for v in os.environ.get('VOICES', '2,8,11,13').split(',') if v.strip()]
CACHE_DIR = Path(os.environ.get('CACHE_DIR', '/cache'))
STOCK_CAP = int(os.environ.get('STOCK_CAP', '20000'))
PORT = int(os.environ.get('PORT', '8080'))

# Chance of each digit count. Keep in sync with DIGIT_WEIGHTS in numbers.js.
DIGIT_WEIGHTS = {1: 0.05, 2: 0.10, 3: 0.25, 4: 0.30, 5: 0.30}

# Only these files are served; everything else in the directory stays private.
STATIC_FILES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/style.css': 'style.css',
    '/numbers.js': 'numbers.js',
    '/app.js': 'app.js',
}

_voice_info = None


def log(msg):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), msg, flush=True)


def engine(path, method='POST', body=None):
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    req = urllib.request.Request(VOICEVOX_URL + path, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def voice_info():
    """Names for the configured style ids, for the page's credit line."""
    global _voice_info
    if _voice_info is None:
        speakers = json.loads(engine('/speakers', method='GET'))
        names = {st['id']: (sp['name'], st['name']) for sp in speakers for st in sp['styles']}
        _voice_info = [
            {'id': v, 'name': names[v][0], 'style': names[v][1]} for v in VOICES if v in names
        ]
    return _voice_info


def random_number():
    digits = random.choices(list(DIGIT_WEIGHTS), weights=list(DIGIT_WEIGHTS.values()))[0]
    low = 10 ** (digits - 1)
    return random.randrange(low, 10 * low)


class Stock:
    """Index of cached clips, grouped by digit count so picks keep the weights."""

    def __init__(self):
        self.lock = threading.Lock()
        self.known = set()
        self.by_digits = {d: [] for d in DIGIT_WEIGHTS}

    def scan(self):
        for voice in VOICES:
            for path in (CACHE_DIR / str(voice)).glob('*.wav'):
                if path.stem.isdigit():
                    self.add(int(path.stem), voice)

    def add(self, n, voice):
        digits = len(str(n))
        with self.lock:
            if digits in self.by_digits and (n, voice) not in self.known:
                self.known.add((n, voice))
                self.by_digits[digits].append((n, voice))

    def has(self, n, voice):
        with self.lock:
            return (n, voice) in self.known

    def size(self):
        with self.lock:
            return len(self.known)

    def pick(self):
        with self.lock:
            available = [d for d, clips in self.by_digits.items() if clips]
            if not available:
                return None
            digits = random.choices(available, weights=[DIGIT_WEIGHTS[d] for d in available])[0]
            return random.choice(self.by_digits[digits])


stock = Stock()

# Numbers /api/next handed out that weren't in stock yet. /api/speak only
# synthesizes these, so visitors can't make the NAS generate arbitrary clips.
_issued_lock = threading.Lock()
_issued = {}
ISSUED_TTL = 600


def issue(n, voice):
    now = time.monotonic()
    with _issued_lock:
        for key in [k for k, t in _issued.items() if now - t > ISSUED_TTL]:
            del _issued[key]
        if len(_issued) < 1000:
            _issued[(n, voice)] = now


def was_issued(n, voice):
    with _issued_lock:
        return (n, voice) in _issued

# Live requests go ahead of the background worker for the engine's attention.
_live_lock = threading.Lock()
_live_waiting = 0


def synthesize(n, voice, live=True):
    global _live_waiting
    path = CACHE_DIR / str(voice) / f'{n}.wav'
    if not path.exists():
        if live:
            with _live_lock:
                _live_waiting += 1
        try:
            start = time.monotonic()
            query = engine(f'/audio_query?speaker={voice}&text={n}')
            wav = engine(f'/synthesis?speaker={voice}', body=query)
        finally:
            if live:
                with _live_lock:
                    _live_waiting -= 1
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f'.{threading.get_ident()}.tmp')
        tmp.write_bytes(wav)
        tmp.replace(path)
        stock.add(n, voice)
        log(f'synth n={n} voice={voice} {time.monotonic() - start:.1f}s'
            f'{" (live)" if live else ""} stock={stock.size()}')
    return path.read_bytes()


def fill_stock():
    """Background worker: warm up the voices, then pre-generate clips up to STOCK_CAP."""
    while True:
        try:
            engine('/version', method='GET')
            break
        except OSError:
            time.sleep(5)
    for voice in VOICES:
        start = time.monotonic()
        try:
            engine(f'/initialize_speaker?speaker={voice}&skip_reinit=true')
            log(f'voice {voice} loaded in {time.monotonic() - start:.1f}s')
        except OSError as e:
            log(f'voice {voice} failed to load: {e}')

    while STOCK_CAP > 0:
        if stock.size() >= STOCK_CAP or _live_waiting:
            time.sleep(60 if stock.size() >= STOCK_CAP else 1)
            continue
        n, voice = random_number(), random.choice(VOICES)
        if stock.has(n, voice):
            continue
        try:
            synthesize(n, voice, live=False)
        except OSError as e:
            log(f'worker: engine error {e}; retrying shortly')
            time.sleep(10)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        try:
            if url.path == '/api/voices':
                return self.send(200, 'application/json', json.dumps(voice_info()).encode())
            if url.path == '/api/next':
                return self.next_clip()
            if url.path == '/api/speak':
                return self.speak(urllib.parse.parse_qs(url.query))
        except OSError as e:
            self.log_error('engine error: %s', e)
            return self.send(502, 'text/plain', b'voice engine unavailable')
        if url.path in STATIC_FILES:
            self.path = '/' + STATIC_FILES[url.path]
            return super().do_GET()
        self.send(404, 'text/plain', b'not found')

    def next_clip(self):
        """A random number + voice, ready-made if the stock has any."""
        pick = stock.pick()
        n, voice = pick or (random_number(), random.choice(VOICES))
        if not pick:
            issue(n, voice)
        body = json.dumps({'n': n, 'voice': voice, 'ready': pick is not None, 'stock': stock.size()})
        self.send(200, 'application/json', body.encode())

    def speak(self, params):
        try:
            n = int(params['n'][0])
            voice = int(params['voice'][0])
        except (KeyError, ValueError):
            return self.send(400, 'text/plain', b'n and voice are required')
        if not 1 <= n <= 99_999 or voice not in VOICES:
            return self.send(400, 'text/plain', b'n or voice out of range')
        if not stock.has(n, voice) and not was_issued(n, voice):
            return self.send(404, 'text/plain', b'clip not available')
        self.send(200, 'audio/wav', synthesize(n, voice), cache='public, max-age=31536000, immutable')

    def send(self, status, ctype, body, cache='no-store'):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if self.path.endswith(('.html', '.js', '.css')):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    stock.scan()
    log(f'jnum on :{PORT}, engine {VOICEVOX_URL}, voices {VOICES}, '
        f'stock {stock.size()} clips (cap {STOCK_CAP})')
    threading.Thread(target=fill_stock, daemon=True).start()
    handler = lambda *a, **kw: Handler(*a, directory=str(ROOT), **kw)
    ThreadingHTTPServer(('', PORT), handler).serve_forever()
