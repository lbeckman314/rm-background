#!/usr/bin/env python3
"""Local development server for the background remover.

Serves the project like any static server, and additionally accepts
PUT /tests/fixtures/<id>.mask.gz and PUT /tests/fixtures/manifest.json, so
tests/fixtures.html can save regenerated model masks straight into the
repository. Nothing else can be written.

    python3 scripts/dev-server.py            # http://localhost:8000
    python3 scripts/dev-server.py --port 8080

Standard library only. Listens on localhost only.
"""

import argparse
import http.server
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
FIXTURE_PATH = re.compile(r"^/tests/fixtures/([a-z0-9-]+\.mask\.gz|manifest\.json)$")
MAX_BYTES = 8 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Always serve fresh files while developing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_PUT(self):
        match = FIXTURE_PATH.match(self.path)
        length = int(self.headers.get("Content-Length", 0))
        if not match or not 0 < length <= MAX_BYTES:
            self.send_error(403, "Only files in tests/fixtures/ can be written")
            return
        FIXTURES.mkdir(parents=True, exist_ok=True)
        (FIXTURES / match[1]).write_bytes(self.rfile.read(length))
        self.send_response(204)
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    port = parser.parse_args().port
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving {ROOT} at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
