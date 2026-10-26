"""The accent pipeline as a small local service, for cards made in the app.

    .venv-accent/Scripts/python tools/accent_helper.py        # or: npm run accent:helper

Zach, 2026-10-26, over a 包帯 card with no reading and no 型: *"when i create a
card it's almost always when im at my laptop, so can't it just use my laptop
automatically?"* The pipeline is Python plus OpenJTalk plus two dictionaries, so
neither the browser nor a Cloudflare Worker can run it. This runs it on the
laptop, and the app (`app/accent-helper.ts`) asks it.

NOTHING HERE IS A SECOND PIPELINE. Every answer comes from the functions the
batch run uses — `accent.derive_value` (the probe rule), `accent_crosscheck`'s
UniDic lookup, `accent_sentence.analyse` / `notation` (OJAD) — and is returned
in the SAME JSON shapes `accent_derive.py` / `accent_crosscheck.py` write to
their files, so the app stores them through the same `loadAccents` path and
`accent_disagreements` sees them like any other row.

─── WHO CAN ASK ───────────────────────────────────────────────────────────────

Bound to 127.0.0.1, so nothing off this machine reaches it. CORS answers only
the app's own origins, so another website open in the same Edge cannot read a
reply. `Access-Control-Allow-Private-Network` is what Edge's "Local Network
Access" check wants; he granted the site once, 2026-10-26, and it is remembered.

─── WHAT IT COSTS, MEASURED 2026-10-26 ────────────────────────────────────────

~40 MB working set with both dictionaries loaded, flat after 100 words; about
0.1 ms a word. Idle between requests — no timers, no polling.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)

# Started hidden at login there is no console, and the pipeline's modules call
# `sys.stdout.reconfigure` on import. Give them a file instead of None.
if sys.stdout is None or sys.stderr is None:
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    log = open(os.path.join(ROOT, "build", "accent-helper.log"), "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or log
    sys.stderr = sys.stderr or log

sys.path.insert(0, TOOLS)

import accent  # noqa: E402
import accent_crosscheck  # noqa: E402
import accent_sentence  # noqa: E402
from accent_derive import accent_version  # noqa: E402

PORT = 47474
PROBE = "が"
ORIGINS = frozenset({
    "https://hashigo.titan-zp4.workers.dev",
    "http://127.0.0.1:5274",
    "http://localhost:5274",
    "http://127.0.0.1:4274",
    "http://localhost:4274",
})
VERSION = accent_version()
TAGGER = accent_crosscheck.fugashi.Tagger()


def derive(value):
    """One key -> the openjtalk row, the unidic row (or None), and UniDic's kana."""
    row = accent.derive_value(value, PROBE)
    row["version"] = VERSION
    row["probe"] = PROBE
    row["analyser"] = "openjtalk"
    # What `accent_derive.py` writes is the whole dict; the loader reads the same
    # keys from it here. `segments`, `bare` and friends travel along unused.

    unidic = None
    kana = None
    pron = None
    tokens = list(TAGGER(value))
    if len(tokens) == 1:
        feature = tokens[0].feature
        kana = getattr(feature, "kana", None) or None
        pron = getattr(feature, "pron", None) or None
    accent_type, ukana, _ = accent_crosscheck.unidic_accent(TAGGER, value)
    if accent_type is not None and ukana:
        moras = accent_crosscheck.mora_count(ukana)
        # The SAME shape `accent_crosscheck.py --emit-rows` writes.
        unidic = {
            "value": value,
            "ok": True,
            "basis": "bare",
            "type": accent_crosscheck.type_for(accent_type, moras) if moras else None,
            "accent_type": accent_type,
            "phrases": [[moras, accent_type]] if moras else [],
            "reading": ukana,
            "version": "unidic/2.3.0",
            "probe": "",
            "analyser": "unidic",
            "reason": None,
        }
    return {"openjtalk": row, "unidic": unidic, "kana": kana, "pron": pron}


def sentence(text):
    """The same record `accent_sentence.py` writes for one sentence."""
    phrases, why = accent_sentence.analyse(text)
    if phrases is None:
        return {"text": text, "ok": False, "why": why}
    return {"text": text, "ok": True, "marks": accent_sentence.notation(phrases)}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Vary", "Origin")

    def _json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": True, "version": VERSION})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        # A page from anywhere else gets no CORS headers and cannot read the reply,
        # but it should not get the work done either.
        if self.headers.get("Origin") not in ORIGINS:
            self._json(403, {"error": "origin not allowed"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                self._json(413, {"error": "too large"})
                return
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/derive":
                values = [str(v) for v in body.get("values", [])][:500]
                self._json(200, {"results": [derive(v) for v in values]})
            elif self.path == "/sentences":
                texts = [str(t) for t in body.get("texts", [])][:500]
                self._json(200, {"lines": [sentence(t) for t in texts]})
            else:
                self._json(404, {"error": "not found"})
        except Exception as error:  # noqa: BLE001 - a bad request must not kill it
            self._json(500, {"error": str(error)})

    def log_message(self, format, *args):  # noqa: A002
        pass  # one line per card is noise; errors come back in the reply


def main():
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        # Already running (the login copy, or a second start): nothing to do.
        print(f"port {PORT} is taken — another helper is already running", flush=True)
        return 0
    print(f"accent helper on http://127.0.0.1:{PORT} ({VERSION})", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
