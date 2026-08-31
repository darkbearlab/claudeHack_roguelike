"""Static server for local playtesting.

Python's stock http.server lets the browser cache ES modules, which makes an
edit-reload loop lie to you: you fix a bug, reload, and the old module is still
in memory. Everything here is served no-store.
"""
import base64
import http.server, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        """Save a screenshot the page hands us.

        Only reachable from 127.0.0.1, only writes into docs/img/, and only
        accepts a basename. It exists because getting a canvas out of the
        browser is otherwise a matter of pasting eighty kilobytes of base64
        through whatever is driving the browser, which is slow and lossy.

            fetch('/__shot/hero.png', {method:'POST',
                  body: canvas.toDataURL('image/png').split(',')[1]})
        """
        if not self.path.startswith("/__shot/"):
            self.send_error(404); return
        name = os.path.basename(self.path[len("/__shot/"):])
        if not name.endswith(".png") or "/" in name or "\\" in name or name.startswith("."):
            self.send_error(400, "bad name"); return

        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 40 * 1024 * 1024:
            self.send_error(400, "bad length"); return

        try:
            data = base64.b64decode(self.rfile.read(length), validate=True)
        except Exception:
            self.send_error(400, "not base64"); return

        out_dir = os.path.join(ROOT, "docs", "img")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, name), "wb") as fh:
            fh.write(data)

        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(f"wrote docs/img/{name} ({len(data)} bytes)".encode())


# Threading matters here. A browser opens several parallel connections to fetch
# a module graph; a single-threaded server serialises them and, with keep-alive,
# can deadlock the page before it finishes loading. That cost half an hour once.
class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


with Server(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving {ROOT} on http://localhost:{PORT}")
    httpd.serve_forever()
