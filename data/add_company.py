"""Add one company-year to Veritas from SEC EDGAR, without touching the cohort dataset.

Resolves a ticker or CIK, then builds the same rows as load_facts.py and fetch_mdna.py for the
fiscal year ending in YEAR and the year before it: as-first-filed facts, quarters, the Beneish row,
the 10-K's MD&A index row and its paragraphs (see item7 and paragraphs below for the two places this
differs from the cohort pipeline, which modern 10-K HTML defeats). Writes them as CSVs
with the dataset's columns into OUT/<cik>_<fy_end>/, plus the MD&A text and meta.json. The app
loads that folder (CSV mode) or sends it to the Zetaris bridge's /load (Zetaris mode).

Usage: python3 -I data/add_company.py <ticker|cik> <year> --out DIR
Prints one JSON line {"id", "cik", "company", "fy_end", "dir"}; exits 1 with a message on failure.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_mdna as fm  # noqa: E402
import load_facts as lf  # noqa: E402

COLUMNS = {
    "facts": ["cik", "company", "role", "fy_end", "concept", "tag", "value", "accn", "filed"],
    "quarters": ["cik", "company", "fy_end", "q_end", "revenue", "rev_tag", "rev_accn", "rev_filed", "derived",
                 "receivables", "ar_accn", "ar_filed"],
    "beneish": ["cik", "company", "role", "sic", "enforcement", "fy_end", "dsri", "gmi", "aqi", "sgi", "depi",
                "sgai", "tata", "lvgi", "m_score", "flagged"],
    "mdna_index": ["cik", "company", "form", "period", "filed", "accn", "doc", "url", "file", "chars", "error"],
    "mdna_paragraphs": ["cik", "period", "para_no", "text", "url"],
}


HEAD7 = re.compile(r"item\s*7\s*[.:\-–—]?\s*management", re.I)
END7 = re.compile(r"item\s*(7a|8)\s*[.:\-–—]?\s*(quantitative|financial statements)", re.I)


class Fail(Exception):
    """A user-facing reason the company-year can't be added."""


def item7(text: str) -> str:
    """MD&A from a heading line to the next Item 7A/8 heading line, longest span (skips the table of contents).
    Headings are short lines, so a running-text cross-reference ("Item 7. Management's Discussion ... and
    the notes thereto") can't start the span, which fetch_mdna.item7 allows. Falls back to fetch_mdna.item7."""
    lines, pos = text.split("\n"), 0
    heads, ends = [], []
    for line in lines:
        s = line.strip()
        if len(s) < 150:
            if HEAD7.match(s):
                heads.append(pos)
            elif END7.match(s):
                ends.append(pos)
        pos += len(line) + 1
    spans = [text[h:e] for h in heads for e in [next((e for e in ends if e > h + 50), None)] if e]
    best = max(spans, key=len, default="").strip()
    return best if len(best) >= 5000 else fm.item7(text)


def paragraphs(text: str) -> list[str]:
    """Blank-line paragraphs as spike.py splits them; blocks over 1500 chars (modern 10-K HTML often has
    no blank lines) are split into their lines so they can qualify for the evidence pack."""
    out = []
    for p in text.split("\n\n"):
        p = p.strip()
        out += [s.strip() for s in p.split("\n") if s.strip()] if len(p) > 1500 else [p] if p else []
    return out


def resolve_cik(company: str) -> int:
    """CIK from a number or a ticker (SEC company_tickers.json, cached next to companyfacts)."""
    if company.isdigit():
        return int(company)
    path = lf.CACHE.parent / "company_tickers.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(fm.get("https://www.sec.gov/files/company_tickers.json"))
    for row in json.loads(path.read_bytes()).values():
        if row["ticker"].upper() == company.upper():
            return int(row["cik_str"])
    raise Fail(f"Unknown ticker {company}")


def display_name(name: str) -> str:
    """'NIKE, Inc.' -> 'Nike'; keeps mixed-case names such as 'MiMedx Group'."""
    name = re.sub(r",?\s+(Inc|Corp|Corporation|Co|Ltd|plc)\.?$", "", name.strip(), flags=re.I)
    return name.title() if name.isupper() else name


def build(cik: int, year: int) -> tuple[dict, dict[str, list[dict]], str]:
    """Rows per table for the fiscal year ending in `year`, plus meta and the MD&A text."""
    lf.YEARS = range(year - 1, year + 1)
    fm.YEARS = range(year, year + 1)
    lf.CACHE.mkdir(parents=True, exist_ok=True)
    try:
        facts = lf.companyfacts(cik)
    except Exception as e:  # 404 for non-XBRL filers, KeyError for no us-gaap facts
        raise Fail(f"No SEC XBRL financial data for CIK {cik} ({type(e).__name__})") from e
    ends = lf.fiscal_year_ends(facts)
    current = [e for e in ends if e.startswith(str(year))]
    if not current:
        raise Fail(f"No 10-K fiscal year ending in {year} for CIK {cik}")
    fy_end = current[-1]
    prior = [e for e in ends if e < fy_end and lf.days(e, fy_end) <= 400]
    if not prior:
        raise Fail(f"No prior fiscal year before {fy_end}; Veritas compares two years")
    p_end = prior[-1]

    sub = json.loads(fm.get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json"))
    company = display_name(sub["name"])
    rows: dict[str, list[dict]] = {t: [] for t in COLUMNS}
    vals: dict[str, dict[str, float]] = {}
    for end in (p_end, fy_end):
        vals[end] = {}
        for key, (instant, tags) in lf.CONCEPTS.items():
            f = lf.first_filed(facts, tags, end, instant)
            if f:
                vals[end][key] = f["value"]
                rows["facts"].append({"cik": cik, "company": company, "role": "", "fy_end": end, "concept": key, **f})
        rows["quarters"] += [{"cik": cik, "company": company, "fy_end": end, **q} for q in lf.first_filed_quarters(facts, end)]
    if "revenue" not in vals[fy_end] or "revenue" not in vals[p_end]:
        raise Fail(f"No annual revenue reported for {fy_end} or {p_end}")
    b = lf.beneish(vals[fy_end], vals[p_end])
    rows["beneish"].append({"cik": cik, "company": company, "role": "", "sic": sub.get("sic", ""), "enforcement": "",
                            "fy_end": fy_end, **({k: round(v, 4) for k, v in b.items()} if b else {}),
                            "flagged": (b["m_score"] > -1.78) if b else ""})

    filings = [f for f in fm.annual_filings(cik) if f["period"] == fy_end]
    if not filings:
        raise Fail(f"No original 10-K with period {fy_end} in EDGAR submissions")
    f = filings[0]
    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{f['accn'].replace('-', '')}/{f['doc']}"
    text = item7(fm.to_text(fm.get(url)))
    if len(text) < 5000:
        raise Fail(f"Could not find the MD&A (Item 7) in the 10-K at {url}")
    name = f"{cik}_{fy_end}.txt"
    rows["mdna_index"].append({"cik": cik, "company": company, **f, "url": url, "file": name, "chars": len(text), "error": ""})
    meta = {"id": f"{cik}_{fy_end}", "cik": cik, "company": company, "fy_end": fy_end, "prior": p_end, "filed": f["filed"]}
    return meta, rows, text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("company", help="ticker or CIK")
    ap.add_argument("year", type=int, help="calendar year the fiscal year ends in")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        meta, rows, text = build(resolve_cik(args.company), args.year)
    except Fail as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    out = Path(args.out) / meta["id"]
    (out / "mdna").mkdir(parents=True, exist_ok=True)
    mdna = out / "mdna" / rows["mdna_index"][0]["file"]
    mdna.write_text(text)
    # Re-read with universal newlines, as the cohort pipeline reads its MD&A files.
    url = rows["mdna_index"][0]["url"]
    rows["mdna_paragraphs"] = [{"cik": meta["cik"], "period": meta["fy_end"], "para_no": i, "text": p, "url": url}
                               for i, p in enumerate(paragraphs(mdna.read_text()))]
    for table, cols in COLUMNS.items():
        with open(out / f"{table}.csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, restval="")
            w.writeheader(); w.writerows(rows[table])
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps({**meta, "dir": str(out)}))


if __name__ == "__main__":
    main()
