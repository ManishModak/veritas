"""Zetaris SQL bridge: lets the TypeScript app run Lightning SQL over Zetaris's JDBC driver.

POST /sql  {"sql": "SELECT ..."}  ->  {"columns": [...], "rows": [[...], ...], "ms": 123}
POST /load {"table", "csv", "cik", "dates"}  ->  {"rows": n}
GET  /health                     ->  {"ok": true}

One JDBC connection, reused, one statement per call, serialized (the driver is not thread-safe).
/load adds one company-year (data/add_company.py output) to the Postgres tables behind the
veritas_pg datasource: it replaces that CIK's rows for the given dates, so Zetaris reads them at once.
Binds 127.0.0.1 only; reach it from elsewhere with `ssh -L 8787:localhost:8787 <host>`.

Usage (on the Zetaris host, in a venv with JayDeBeApi):
  ZETARIS_USER=... ZETARIS_PASSWORD=... python3 zetaris_bridge.py \
      --jar /root/zetaris-platform/jdbc/ndp-jdbc-driver-2.4.3.1-7eff043-driver.jar
"""
from __future__ import annotations

import argparse
import datetime
import decimal
import json
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jaydebeapi

DRIVER = "com.zetaris.lightning.jdbc.LightningDriver"
DATE_COLUMN = {"facts": "fy_end", "quarters": "fy_end", "beneish": "fy_end", "mdna_index": "period", "mdna_paragraphs": "period"}


def load(table: str, text: str, cik: int, dates: list[str]) -> dict:
    """Replace one CIK's rows for `dates` in a veritas-pg table with the CSV rows, in one transaction."""
    if table not in DATE_COLUMN or not isinstance(cik, int) or cik <= 0 \
            or not dates or not all(isinstance(d, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in dates):
        raise ValueError("expected table, positive integer cik and YYYY-MM-DD dates")
    # Python's csv module ends rows with \r\n; COPY needs one newline style, including the \. end marker.
    header, _, body = text.replace("\r\n", "\n").partition("\n")
    cols = header.strip().split(",")
    if not all(re.fullmatch(r"[a-z_]+", c) for c in cols) or any(line == "\\." for line in body.splitlines()):
        raise ValueError("bad CSV header or body")
    script = (f"BEGIN;\nDELETE FROM {table} WHERE cik = {cik} AND {DATE_COLUMN[table]} IN ({', '.join(repr(d) for d in dates)});\n"
              f"COPY {table}({', '.join(cols)}) FROM STDIN WITH (FORMAT csv);\n{body.rstrip(chr(10))}\n\\.\nCOMMIT;\n")
    out = subprocess.run(["docker", "exec", "-i", "veritas-pg", "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "veritas",
                          "-d", "veritas"], input=script, capture_output=True, text=True, timeout=60)
    if out.returncode:
        raise RuntimeError(out.stderr.strip()[-500:])
    return {"ok": True}


class Zetaris:
    """A single lazily (re)opened JDBC connection, guarded by a lock."""

    def __init__(self, jar: str, url: str) -> None:
        self.jar, self.url, self.conn, self.lock = jar, url, None, threading.Lock()

    def query(self, sql: str) -> dict:
        with self.lock:
            for attempt in (1, 2):  # one reconnect if the connection went stale
                try:
                    if self.conn is None:
                        self.conn = jaydebeapi.connect(
                            DRIVER, self.url, [os.environ["ZETARIS_USER"], os.environ["ZETARIS_PASSWORD"]], self.jar)
                    t = time.time()
                    cur = self.conn.cursor()
                    cur.execute(sql)
                    cols = [d[0] for d in cur.description] if cur.description else []
                    rows = [[plain(v) for v in r] for r in cur.fetchall()] if cols else []
                    cur.close()
                    return {"columns": cols, "rows": rows, "ms": round(1000 * (time.time() - t))}
                except Exception:
                    if attempt == 2:
                        raise
                    try:
                        self.conn.close()
                    except Exception:
                        pass
                    self.conn = None
        raise AssertionError("unreachable")


def plain(v):
    """JDBC values -> JSON-safe values."""
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    if v is not None and not isinstance(v, (int, float, str, bool)):
        return str(v)
    return v


def make_handler(z: Zetaris):
    class Handler(BaseHTTPRequestHandler):
        def send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self.send(200, {"ok": True}) if self.path == "/health" else self.send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path not in ("/sql", "/load"):
                return self.send(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if self.path == "/load":
                    return self.send(200, load(body["table"], body["csv"], body["cik"], body["dates"]))
                self.send(200, z.query(body["sql"]))
            except Exception as e:  # report the Zetaris error to the caller, loudly
                self.send(400, {"error": f"{type(e).__name__}: {e}"})

        def log_message(self, fmt: str, *args) -> None:
            print(f"{self.address_string()} {fmt % args}", flush=True)

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jar", required=True)
    ap.add_argument("--url", default="jdbc:zetaris:lightning@localhost:10000")
    ap.add_argument("--port", type=int, default=8787)
    a = ap.parse_args()
    z = Zetaris(a.jar, a.url)
    print(f"bridge on 127.0.0.1:{a.port} -> {a.url}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(z)).serve_forever()


if __name__ == "__main__":
    main()
