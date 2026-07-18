#!/usr/bin/env python3
"""Dev server that mimics GitHub Pages: any path that doesn't match a file is
answered with 404.html (status 404), which stashes the path and bounces back
through /. The stock `python3 -m http.server` lacks this, so reloading after
app.js rewrites / to /<slug> dead-ends in a bare 404.

Usage: python3 serve.py [port]     (default 8000)
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent


class PagesHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # A dev server must never lie about freshness: without this,
        # Chrome's heuristic caching (~10% of a file's age) can serve
        # hour-stale CSS on plain navigations. Production (GitHub
        # Pages) sends max-age=600 instead; that 10-minute window is
        # its own, accepted.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        if code != 404:  # only 404s get the GitHub Pages treatment
            return super().send_error(code, message, explain)
        body = (ROOT / '404.html').read_bytes()
        self.send_response(404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':  # HTTP forbids bodies on HEAD responses
            self.wfile.write(body)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
handler = functools.partial(PagesHandler, directory=str(ROOT))
print(f'serving {ROOT} at http://localhost:{port}/ '
      '(with GitHub-Pages-style 404.html fallback)')
http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
