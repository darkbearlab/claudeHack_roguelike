"""Static server for local playtesting.

Python's stock http.server lets the browser cache ES modules, which makes an
edit-reload loop lie to you: you fix a bug, reload, and the old module is still
in memory. Everything here is served no-store.
"""
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


# Threading matters here. A browser opens several parallel connections to fetch
# a module graph; a single-threaded server serialises them and, with keep-alive,
# can deadlock the page before it finishes loading. That cost half an hour once.
class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


with Server(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving {ROOT} on http://localhost:{PORT}")
    httpd.serve_forever()
