"""Build the as-filed financial dataset for the Veritas blind run.

For every company in cohort.json, fetch SEC EDGAR companyfacts, keep each fiscal-year
value exactly as it was FIRST reported in a 10-K (later restatements are ignored), and
compute the Beneish M-score inputs. Writes:
  out/facts.csv    one row per company, fiscal year and concept, with tag, accession and filed date (the citation)
  out/beneish.csv  one row per company-year with the 8 Beneish indices, the M-score and the flag
  out/quarters.csv one row per fiscal quarter: revenue and quarter-end receivables as first filed (10-Q/10-K)

Usage: python3 -I load_facts.py [--out DIR]   (raw JSON is cached in $VERITAS_CACHE, default ~/.cache/veritas)
"""
from __future__ import annotations

import argparse
import os
import csv
import gzip
import json
import time
import urllib.request
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
CACHE = Path(os.environ.get("VERITAS_CACHE", Path.home() / ".cache/veritas/companyfacts"))
UA = {"User-Agent": "Manish Modak modakm.dev@gmail.com", "Accept-Encoding": "gzip"}
YEARS = range(2011, 2020)  # fiscal years (by period end) kept

# Concept -> US-GAAP tags in priority order. Tried per period, so a filer that switches tags
# (e.g. ASC 606 in 2018) still resolves. "instant" concepts are balance-sheet values.
CONCEPTS: dict[str, tuple[bool, list[str]]] = {
    "revenue": (False, ["Revenues", "SalesRevenueNet", "SalesRevenueGoodsNet",
                        "RevenueFromContractWithCustomerExcludingAssessedTax"]),
    "cogs": (False, ["CostOfGoodsSold", "CostOfGoodsAndServicesSold", "CostOfRevenue"]),
    "sga": (False, ["SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense"]),
    "depreciation": (False, ["Depreciation", "DepreciationAndAmortization",
                             "DepreciationDepletionAndAmortization"]),
    "net_income": (False, ["NetIncomeLoss"]),
    "cfo": (False, ["NetCashProvidedByUsedInOperatingActivities"]),
    "receivables": (True, ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent",
                           "AccountsNotesAndLoansReceivableNetCurrent", "AccountsReceivableNet"]),
    "current_assets": (True, ["AssetsCurrent"]),
    "ppe": (True, ["PropertyPlantAndEquipmentNet"]),
    "assets": (True, ["Assets"]),
    "current_liabilities": (True, ["LiabilitiesCurrent"]),
    "lt_debt": (True, ["LongTermDebtNoncurrent", "LongTermDebt"]),
}


def companyfacts(cik: int) -> dict:
    """Return the us-gaap facts for a CIK, from cache or the SEC API (rate-limited)."""
    path = CACHE / f"CIK{cik:010d}.json"
    if not path.exists():
        req = urllib.request.Request(
            f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json", headers=UA)
        raw = urllib.request.urlopen(req, timeout=60).read()
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
        json.loads(raw)  # fail loudly on a bad body before caching it
        path.write_bytes(raw)
        time.sleep(0.2)
    return json.loads(path.read_bytes())["facts"]["us-gaap"]


def days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def first_filed_revenue(facts: dict, tags: list[str], end: str) -> dict | None:
    """Total revenue as first filed: among all revenue tags in the earliest 10-K for the period,
    the largest value. Tag order can't be trusted (UA's FY2015 10-K put total net revenues under
    SalesRevenueGoodsNet and net sales excluding license revenue under SalesRevenueNet)."""
    rows = [(tag, r) for tag in tags for r in facts.get(tag, {}).get("units", {}).get("USD", [])
            if r["end"] == end and r["form"] in ("10-K", "10-KT")
            and "start" in r and 350 <= days(r["start"], r["end"]) <= 380]
    if not rows:
        return None
    first = min(r["filed"] for _, r in rows)
    tag, r = max(((t, r) for t, r in rows if r["filed"] == first), key=lambda x: x[1]["val"])
    return {"tag": tag, "value": r["val"], "accn": r["accn"], "filed": r["filed"]}


def first_filed(facts: dict, tags: list[str], end: str, instant: bool) -> dict | None:
    """The earliest 10-K fact for the period ending `end`, trying tags in order."""
    if tags is CONCEPTS["revenue"][1]:
        return first_filed_revenue(facts, tags, end)
    for tag in tags:
        rows = [r for r in facts.get(tag, {}).get("units", {}).get("USD", [])
                if r["end"] == end and r["form"] in ("10-K", "10-KT")
                and (instant or ("start" in r and 350 <= days(r["start"], r["end"]) <= 380))]
        if rows:
            r = min(rows, key=lambda r: (r["filed"], r["accn"]))
            return {"tag": tag, "value": r["val"], "accn": r["accn"], "filed": r["filed"]}
    return None


def first_filed_quarters(facts: dict, fy_end: str) -> list[dict]:
    """The fiscal year's quarters as first filed: revenue (largest revenue tag in the earliest filing,
    as for annual revenue) and quarter-end receivables. Q4 revenue, when no 10-K reports the quarter
    alone, is derived as annual minus the 9-month year-to-date figure."""
    annual = first_filed_revenue(facts, CONCEPTS["revenue"][1], fy_end)
    if not annual:
        return []
    rows = [(tag, r) for tag in CONCEPTS["revenue"][1] for r in facts.get(tag, {}).get("units", {}).get("USD", [])
            if r["form"] in ("10-Q", "10-K", "10-KT") and "start" in r and r["end"] <= fy_end
            and days(r["end"], fy_end) < 300]
    def pick(cands: list) -> dict | None:
        if not cands:
            return None
        first = min(r["filed"] for _, r in cands)
        tag, r = max(((t, r) for t, r in cands if r["filed"] == first), key=lambda x: x[1]["val"])
        return {"tag": tag, "value": r["val"], "accn": r["accn"], "filed": r["filed"], "start": r["start"]}
    ends = sorted({r["end"] for _, r in rows if 80 <= days(r["start"], r["end"]) <= 100})
    out = []
    for end in ends:
        q = pick([(t, r) for t, r in rows if r["end"] == end and 80 <= days(r["start"], r["end"]) <= 100])
        out.append({"q_end": end, "revenue": q["value"], "rev_tag": q["tag"], "rev_accn": q["accn"],
                    "rev_filed": q["filed"], "derived": False})
    if fy_end not in ends:  # Q4 = annual - 9 months YTD
        ytd = pick([(t, r) for t, r in rows if 260 <= days(r["start"], r["end"]) <= 280
                    and days(r["end"], fy_end) <= 100])
        if ytd:
            out.append({"q_end": fy_end, "revenue": annual["value"] - ytd["value"], "rev_tag": annual["tag"],
                        "rev_accn": annual["accn"], "rev_filed": annual["filed"], "derived": True})
    for q in out:
        ar = _first_any(facts, CONCEPTS["receivables"][1], q["q_end"])
        q.update({"receivables": ar["value"] if ar else None, "ar_accn": ar["accn"] if ar else "",
                  "ar_filed": ar["filed"] if ar else ""})
    return out


def _first_any(facts: dict, tags: list[str], end: str) -> dict | None:
    """Earliest instant value at `end` from a 10-Q or 10-K (quarter ends appear only in 10-Qs)."""
    for tag in tags:
        rows = [r for r in facts.get(tag, {}).get("units", {}).get("USD", [])
                if r["end"] == end and r["form"] in ("10-Q", "10-K", "10-KT") and "start" not in r]
        if rows:
            r = min(rows, key=lambda r: (r["filed"], r["accn"]))
            return {"tag": tag, "value": r["val"], "accn": r["accn"], "filed": r["filed"]}
    return None


def fiscal_year_ends(facts: dict) -> list[str]:
    """Annual period end dates, taken from revenue/net income facts in 10-Ks."""
    ends = set()
    for tag in CONCEPTS["revenue"][1] + ["NetIncomeLoss"]:
        for r in facts.get(tag, {}).get("units", {}).get("USD", []):
            if r["form"] in ("10-K", "10-KT") and "start" in r \
                    and 350 <= days(r["start"], r["end"]) <= 380 and int(r["end"][:4]) in YEARS:
                ends.add(r["end"])
    return sorted(ends)


def beneish(t: dict[str, float], p: dict[str, float]) -> dict[str, float] | None:
    """Beneish (1999) 8-variable M-score for year t vs prior year p; None if inputs missing."""
    need = ["revenue", "cogs", "receivables", "current_assets", "ppe", "assets",
            "current_liabilities", "net_income", "cfo", "sga"]
    if any(k not in t or k not in p or not p[k] for k in need) or not t["revenue"]:
        return None
    dsri = (t["receivables"] / t["revenue"]) / (p["receivables"] / p["revenue"])
    gmi = ((p["revenue"] - p["cogs"]) / p["revenue"]) / ((t["revenue"] - t["cogs"]) / t["revenue"])
    aqi = (1 - (t["current_assets"] + t["ppe"]) / t["assets"]) / \
          (1 - (p["current_assets"] + p["ppe"]) / p["assets"])
    sgi = t["revenue"] / p["revenue"]
    depi = 1.0
    if t.get("depreciation") and p.get("depreciation"):
        depi = (p["depreciation"] / (p["depreciation"] + p["ppe"])) / \
               (t["depreciation"] / (t["depreciation"] + t["ppe"]))
    sgai = (t["sga"] / t["revenue"]) / (p["sga"] / p["revenue"])
    tata = (t["net_income"] - t["cfo"]) / t["assets"]
    lvgi = ((t["current_liabilities"] + t.get("lt_debt", 0)) / t["assets"]) / \
           ((p["current_liabilities"] + p.get("lt_debt", 0)) / p["assets"])
    m = (-4.84 + 0.920 * dsri + 0.528 * gmi + 0.404 * aqi + 0.892 * sgi + 0.115 * depi
         - 0.172 * sgai + 4.679 * tata - 0.327 * lvgi)
    return {"dsri": dsri, "gmi": gmi, "aqi": aqi, "sgi": sgi, "depi": depi, "sgai": sgai,
            "tata": tata, "lvgi": lvgi, "m_score": m}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "out"))
    out = Path(ap.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    cohort = json.loads((HERE / "cohort.json").read_text())["companies"]

    fact_rows, score_rows, quarter_rows = [], [], []
    for c in cohort:
        facts = companyfacts(c["cik"])
        years: list[tuple[str, dict[str, float]]] = []
        for end in fiscal_year_ends(facts):
            vals = {}
            for key, (instant, tags) in CONCEPTS.items():
                f = first_filed(facts, tags, end, instant)
                if f:
                    vals[key] = f["value"]
                    fact_rows.append({"cik": c["cik"], "company": c["name"], "role": c["role"],
                                      "fy_end": end, "concept": key, **f})
            years.append((end, vals))
            quarter_rows += [{"cik": c["cik"], "company": c["name"], "fy_end": end, **q}
                             for q in first_filed_quarters(facts, end)]
        for (p_end, p), (t_end, t) in zip(years, years[1:]):
            if days(p_end, t_end) > 400:  # gap in annual data
                continue
            b = beneish(t, p)
            score_rows.append({"cik": c["cik"], "company": c["name"], "role": c["role"],
                               "sic": c["sic"], "enforcement": c.get("enforcement", ""),
                               "fy_end": t_end,
                               **({k: round(v, 4) for k, v in b.items()} if b else {}),
                               "flagged": (b["m_score"] > -1.78) if b else ""})
        print(f"{c['name']:22} years={len(years)} scored={sum(1 for r in score_rows if r['cik']==c['cik'] and r.get('m_score') is not None)}")

    with open(out / "facts.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(fact_rows[0]))
        w.writeheader(); w.writerows(fact_rows)
    cols = ["cik", "company", "role", "sic", "enforcement", "fy_end", "dsri", "gmi", "aqi", "sgi",
            "depi", "sgai", "tata", "lvgi", "m_score", "flagged"]
    with open(out / "beneish.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, restval="")
        w.writeheader(); w.writerows(score_rows)
    with open(out / "quarters.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(quarter_rows[0]))
        w.writeheader(); w.writerows(quarter_rows)
    print(f"wrote {len(fact_rows)} facts, {len(score_rows)} company-years, {len(quarter_rows)} quarters -> {out}")


if __name__ == "__main__":
    main()
