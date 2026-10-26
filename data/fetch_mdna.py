"""Extract management's own explanation (10-K Item 7, MD&A) for every company in cohort.json.

For each 10-K with a fiscal year in YEARS, fetch the primary document from EDGAR, strip the
HTML and cut out Item 7 (up to Item 7A or Item 8). Writes:
  out/mdna/<cik>_<period>.txt   the MD&A text
  out/mdna/index.csv            cik, company, form, period, filed, accession and source URL (the citation)

Usage: python3 -I fetch_mdna.py [--out DIR]
"""
from __future__ import annotations

import argparse
import csv
import gzip
import html
import json
import re
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
UA = {"User-Agent": "Manish Modak modakm.dev@gmail.com", "Accept-Encoding": "gzip"}
YEARS = range(2012, 2020)


def get(url: str) -> bytes:
    """GET with the SEC-required User-Agent, gzip-aware, paced under 10 requests/s."""
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
    time.sleep(0.15)
    try:
        return gzip.decompress(raw)
    except OSError:
        return raw


def annual_filings(cik: int) -> list[dict]:
    """All original 10-K filings (not amendments) from the submissions API, incl. older pages."""
    sub = json.loads(get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json"))
    pages = [sub["filings"]["recent"]] + [
        json.loads(get(f"https://data.sec.gov/submissions/{f['name']}")) for f in sub["filings"].get("files", [])]
    out = []
    for p in pages:
        for i, form in enumerate(p["form"]):
            if form in ("10-K", "10-KT") and p["reportDate"][i][:4].isdigit() \
                    and int(p["reportDate"][i][:4]) in YEARS:
                out.append({"form": form, "period": p["reportDate"][i], "filed": p["filingDate"][i],
                            "accn": p["accessionNumber"][i], "doc": p["primaryDocument"][i]})
    return sorted(out, key=lambda r: r["period"])


def to_text(raw: bytes) -> str:
    t = raw.decode("utf-8", errors="replace")
    t = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", t)
    t = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", t)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t)).replace("\xa0", " ")
    t = re.sub(r"[ \t]+", " ", t)
    return re.sub(r"\n\s*\n+", "\n\n", t)


def item7(text: str) -> str:
    """Longest span from an 'Item 7. Management's Discussion' heading to the next Item 7A/8.
    Taking the longest skips the table-of-contents entry."""
    starts = [m.start() for m in re.finditer(r"(?i)item\s*7\s*[.:\-–—]?\s*management", text)]
    best = ""
    for s in starts:
        m = re.search(r"(?i)item\s*(7a|8)\s*[.:\-–—]?\s*(quantitative|financial statements)", text[s + 50:])
        span = text[s: s + 50 + m.start()] if m else ""
        if len(span) > len(best):
            best = span
    return best.strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "out"))
    out = Path(ap.parse_args().out) / "mdna"
    out.mkdir(parents=True, exist_ok=True)
    cohort = json.loads((HERE / "cohort.json").read_text())["companies"]
    rows = []
    for c in cohort:
        for f in annual_filings(c["cik"]):
            url = f"https://www.sec.gov/Archives/edgar/data/{c['cik']}/{f['accn'].replace('-', '')}/{f['doc']}"
            try:
                text = item7(to_text(get(url)))
            except Exception as e:  # keep going; the row records the failure
                text, f["error"] = "", f"{type(e).__name__}: {e}"
            name = f"{c['cik']}_{f['period']}.txt"
            (out / name).write_text(text)
            rows.append({"cik": c["cik"], "company": c["name"], **f, "url": url, "file": name,
                         "chars": len(text), "error": f.get("error", "")})
            print(f"{c['name']:22} {f['period']} {len(text):>7} chars {f.get('error', '')}", flush=True)
    with open(out / "index.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["cik", "company", "form", "period", "filed", "accn", "doc",
                                           "url", "file", "chars", "error"])
        w.writeheader(); w.writerows(rows)
    empty = sum(1 for r in rows if r["chars"] < 5000)
    print(f"wrote {len(rows)} MD&A sections; {empty} under 5k chars (check those)")


if __name__ == "__main__":
    main()
