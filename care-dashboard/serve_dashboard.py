# -*- coding: utf-8 -*-
"""
Serves this folder on http://localhost:8787 so index.html can fetch
care_email_test_output.csv by itself and auto-refresh every 60 seconds.

Why this exists: browsers block a page opened by double-click
(file://...) from reading a sibling file. Serving the same folder over
plain HTTP on your own machine removes that block, with nothing going
over the network and no Microsoft 365 / admin approval involved.

Run:   python serve_dashboard.py
Then open http://localhost:8787 in your browser and leave this window
running. Stop with Ctrl+C.
"""

import http.server
import os

PORT = 8787

os.chdir(os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    handler = http.server.SimpleHTTPRequestHandler
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"Serving this folder at http://localhost:{PORT}/")
        print("Open that link in your browser. Press Ctrl+C here to stop.")
        httpd.serve_forever()
