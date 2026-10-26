"""Spike: can Nemotron Ultra explain a company-year from an evidence pack, citing every claim?

Builds an evidence pack (as-filed numbers + derived signals + MD&A paragraphs, each with an id),
runs investigator, red-team and judge passes on nvidia/nemotron-3-ultra-550b-a55b, then checks
that every cited id exists. Runs N samples and saves them, with verdict agreement, to ../runs/<cik>_<fy_end>.json.

Usage: NVIDIA_API_KEY=... python3 -I spike.py <cik> <fy_end> [samples=3]   e.g. 1336917 2015-12-31
Data: ../data/out/{facts.csv,beneish.csv,mdna/}
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import time
from collections import Counter
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data/out"
MODEL = "nvidia/nemotron-3-ultra-550b-a55b"
KEYWORDS = re.compile(r"(?i)net revenues?|net sales|revenue growth|receivable|cash (provided|flows?) from operat"
                      r"|wholesale|direct.to.consumer|lease|842|right.of.use|days sales|inventor")


def evidence_pack(cik: int, fy_end: str) -> tuple[str, list[dict]]:
    """Return (company name, evidence items). Each item: id, kind, text, source."""
    facts = [r for r in csv.DictReader(open(DATA / "facts.csv")) if int(r["cik"]) == cik]
    ends = sorted({r["fy_end"] for r in facts})
    prior = ends[ends.index(fy_end) - 1]
    name = facts[0]["company"]
    items: list[dict] = []
    for r in facts:
        if r["fy_end"] in (prior, fy_end):
            items.append({"kind": "fact", "text": f"{r['concept']} for fiscal year ending {r['fy_end']} = "
                          f"${float(r['value'])/1e6:,.1f}M (XBRL tag {r['tag']})",
                          "source": f"10-K accession {r['accn']}, filed {r['filed']}"})
    v = {(r["fy_end"], r["concept"]): float(r["value"]) for r in facts}
    def t(k): return v.get((fy_end, k))
    def p(k): return v.get((prior, k))
    g = (t, p)
    if all(x(k) for x in g for k in ("revenue", "receivables")):
        items.append({"kind": "signal", "text": f"Revenue growth {100*(t('revenue')/p('revenue')-1):.1f}% vs receivables "
                      f"growth {100*(t('receivables')/p('receivables')-1):.1f}%; days sales outstanding "
                      f"{365*p('receivables')/p('revenue'):.0f} -> {365*t('receivables')/t('revenue'):.0f} days",
                      "source": "computed from the revenue and receivables facts"})
    if all(x(k) is not None for x in g for k in ("net_income", "cfo")):
        items.append({"kind": "signal", "text": f"Net income ${p('net_income')/1e6:,.1f}M -> ${t('net_income')/1e6:,.1f}M while "
                      f"operating cash flow ${p('cfo')/1e6:,.1f}M -> ${t('cfo')/1e6:,.1f}M",
                      "source": "computed from the net income and cash-flow facts"})
    items += quarter_signals(cik, prior, fy_end, t("revenue"), p("revenue"))
    b = next(r for r in csv.DictReader(open(DATA / "beneish.csv"))
             if int(r["cik"]) == cik and r["fy_end"] == fy_end)
    if b["m_score"]:
        items.append({"kind": "signal", "text": "Beneish M-score = {m_score} (flag threshold -1.78; flagged={flagged}). "
                      "Indices: DSRI={dsri} GMI={gmi} AQI={aqi} SGI={sgi} DEPI={depi} SGAI={sgai} TATA={tata} "
                      "LVGI={lvgi}".format(**b), "source": "computed from the facts above (Beneish 1999)"})
    idx = next(r for r in csv.DictReader(open(DATA / "mdna/index.csv"))
               if int(r["cik"]) == cik and r["period"] == fy_end)
    paras = [p.strip() for p in (DATA / "mdna" / idx["file"]).read_text().split("\n\n")]
    for p in [p for p in paras if 120 < len(p) < 1500 and KEYWORDS.search(p)][:25]:
        items.append({"kind": "mdna", "text": p, "source": f"10-K MD&A, {idx['url']}"})
    for i, it in enumerate(items, 1):
        it["id"] = f"E{i}"
    return name, items


def quarter_signals(cik: int, prior: str, fy_end: str, rev_t: float | None, rev_p: float | None) -> list[dict]:
    """One signal per fiscal quarter: revenue and quarter-end receivables vs the same quarter a year
    earlier, with quarter-end DSO. Emitted only when both years have 4 quarters with receivables that
    sum to annual revenue within 2%; otherwise one item saying the quarterly data is incomplete."""
    qs = [r for r in csv.DictReader(open(DATA / "quarters.csv")) if int(r["cik"]) == cik]
    cur = sorted((r for r in qs if r["fy_end"] == fy_end), key=lambda r: r["q_end"])
    old = sorted((r for r in qs if r["fy_end"] == prior), key=lambda r: r["q_end"])
    def ok(rows, annual):
        return len(rows) == 4 and all(r["receivables"] for r in rows) and annual \
            and abs(sum(float(r["revenue"]) for r in rows) / annual - 1) <= 0.02
    if not (ok(cur, rev_t) and ok(old, rev_p)):
        return [{"kind": "signal", "text": "Quarterly revenue/receivables data is incomplete for this year; "
                 "no quarter-level comparison.", "source": "10-Q/10-K XBRL facts"}]
    out = []
    for n, (c, o) in enumerate(zip(cur, old), 1):
        rc, ro, ac, ao = (float(x) for x in (c["revenue"], o["revenue"], c["receivables"], o["receivables"]))
        out.append({"kind": "signal", "text": f"Fiscal Q{n} (quarter ending {c['q_end']}): revenue ${rc/1e6:,.1f}M vs "
                    f"${ro/1e6:,.1f}M a year earlier ({100*(rc/ro-1):+.1f}%); quarter-end receivables ${ac/1e6:,.1f}M vs "
                    f"${ao/1e6:,.1f}M ({100*(ac/ao-1):+.1f}%); quarter-end DSO {91*ao/ro:.0f} -> {91*ac/rc:.0f} days"
                    + (" (Q4 revenue derived as annual minus 9-month YTD)" if c["derived"] == "True" else ""),
                    "source": f"10-Q/10-K accessions {c['rev_accn']}, {c['ar_accn']} (and prior-year {o['rev_accn']})"})
    return out


def ask(system: str, user: str) -> dict:
    """One Ultra call (reasoning on); returns the parsed JSON object from the answer."""
    body = {"model": MODEL, "temperature": 0.3, "max_tokens": 16000,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    req = urllib.request.Request("https://integrate.api.nvidia.com/v1/chat/completions",
                                 data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {os.environ['NVIDIA_API_KEY']}",
                                          "Content-Type": "application/json"})
    t = time.time()
    resp = json.loads(urllib.request.urlopen(req, timeout=300).read())
    msg = resp["choices"][0]["message"]
    print(f"  [{time.time()-t:.1f}s, {resp['usage']}, finish={resp['choices'][0].get('finish_reason')}, "
          f"reasoning_field={'reasoning_content' in msg and bool(msg['reasoning_content'])}]", file=sys.stderr)
    text = msg["content"] or ""
    m = re.search(r"\{\s*\"(verdict|rebuttals|final_verdict)\".*\}", text, re.S)  # the answer object, not braces inside the reasoning
    return json.loads(m.group(0)) if m else {"raw": text}


# Shared rule for all three roles: management's own explanations are claims under test (audit-style
# professional skepticism), never proof of themselves.
EVIDENCE_RULES = """Evidence kinds: "fact" = as-filed XBRL numbers; "signal" = computed from facts; "mdna" = management's
own words. Figures that management reports in MD&A (segment sales, growth rates, cash-flow line items) count as
reported numbers. Management's CAUSAL explanations ("due to", "driven by", "timing of shipments") are the claims
under test: they never prove themselves. An explanation is corroborated only when reported numbers show the named
driver AND its size is large enough to account for the pattern. Matching amounts is not corroboration: management's
figure for HOW MUCH receivables or inventory rose does not show WHY. A named driver must be visible on its own in the
numbers (a mix shift in segment sales, an acquisition in segment or acquired revenue, a timing effect in the
quarter-level signals). Use ONLY the evidence pack, cite ids for every
statement, and never invent numbers."""

INVESTIGATOR = """You are a forensic accountant. You get an evidence pack about one company's fiscal year, each item
with an id (E1, E2, ...). Question: management says WHY its revenue grew and why receivables and cash flow moved.
Do those stated reasons fit the pattern in receivables and operating cash flow? Healthy demand growth usually shows
up as cash collected; growth that piles up in receivables or outruns cash flow needs an explanation that the
numbers support. Judge the explanation, not accounting presentation differences.
Also check that management's explanations agree with each other. If receivables or cash flow are explained by
shipment timing, longer payment terms or channel loading, then that part of revenue growth came from timing or
terms rather than from the demand drivers management credits for growth: estimate how large that part is from the
quarter-level signals, and say whether the growth explanation still holds.
""" + EVIDENCE_RULES + """
Answer with one JSON object:
{"verdict": "explanation fits the numbers" | "explanation does not fit the numbers" | "explanation unverified",
 "summary": "<2 sentences>",
 "findings": [{"management_says": "...", "numbers_show": "...", "fit": "fits" | "does not fit" | "unverified",
               "evidence": ["E3", "E40"]}],
 "questions_for_management": ["..."],
 "what_would_change_my_mind": ["..."]}"""

RED_TEAM = """You are defending the company. You get the same evidence pack plus an investigator's findings.
For each finding, give the strongest innocent explanation and say what supports it: "numbers" (reported numbers in
the pack show the driver at a size that accounts for the pattern), "management's word" (only management's causal
explanation supports it) or "outside the pack" (it needs facts the pack does not contain).
""" + EVIDENCE_RULES + """
Answer with one JSON object:
{"rebuttals": [{"finding_index": 0, "innocent_explanation": "...", "evidence": ["E2"], "support": "numbers"}],
 "overall": "<does the investigator's verdict stand? 2 sentences>"}"""

JUDGE = """You are the judge between a forensic investigator and a defender, reviewing one company's fiscal year.
You get the evidence pack, the investigator's findings and the defender's rebuttals. For each finding rule:
"fits" (reported numbers corroborate management's explanation at the right size), "does not fit" (the numbers
contradict it or the named driver is too small to explain the pattern) or "unverified" (the explanation rests on
management's word or on facts outside the pack). A suspicious pattern alone is not proof of wrongdoing, and an
innocent story alone is not proof of innocence.
""" + EVIDENCE_RULES + """
Answer with one JSON object:
{"final_verdict": "explanation fits the numbers" | "explanation does not fit the numbers" | "explanation unverified",
 "confidence": 0.0-1.0,
 "rulings": [{"finding_index": 0, "ruling": "fits", "reason": "...", "evidence": ["E3"]}],
 "deciding_evidence": "<the one or two facts that decide it, with ids>",
 "evidence_that_would_settle_it": ["<a specific document or number not in the pack, and what it would show>"]}"""


def grounding(result: dict, key: str, ids: set[str]) -> dict:
    """Citation check for one stage: counts, ids not in the pack, items without evidence."""
    cited = [e for c in result.get(key, []) for e in c.get("evidence", [])]
    return {"citations": len(cited), "unknown_ids": [e for e in cited if e not in ids],
            "uncited": sum(1 for c in result.get(key, []) if not c.get("evidence"))}


def run_once(head: str, ids: set[str]) -> dict:
    """One investigator -> red-team -> judge pass over the evidence pack text `head`."""
    inv = ask(INVESTIGATOR, head)
    red = ask(RED_TEAM, f"{head}\n\nInvestigator findings:\n{json.dumps(inv)}")
    judge = ask(JUDGE, f"{head}\n\nInvestigator findings:\n{json.dumps(inv)}\n\nDefender rebuttals:\n{json.dumps(red)}")
    checks = {"investigator": grounding(inv, "findings", ids), "red_team": grounding(red, "rebuttals", ids),
              "judge": grounding(judge, "rulings", ids)}
    print(f"== grounding: {json.dumps(checks)}", file=sys.stderr)
    return {"investigator": inv, "red_team": red, "judge": judge, "grounding": checks}


def main() -> None:
    """Run N independent passes (default 3) and save them with verdict agreement to ../runs/<cik>_<fy_end>.json."""
    cik, fy_end = int(sys.argv[1]), sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    name, items = evidence_pack(cik, fy_end)
    pack = "\n".join(f"[{it['id']}] ({it['kind']}) {it['text']}  -- source: {it['source']}" for it in items)
    head = f"Company: {name}\nEvidence pack:\n{pack}"
    print(f"== {name} FY ending {fy_end}: {len(items)} evidence items, {n} samples", file=sys.stderr)
    samples = [run_once(head, {it["id"] for it in items}) for _ in range(n)]
    agreement = {stage: dict(Counter(s[stage].get(key, "?") for s in samples))
                 for stage, key in (("investigator", "verdict"), ("judge", "final_verdict"))}
    print(f"== agreement: {json.dumps(agreement)}", file=sys.stderr)
    out = Path(__file__).resolve().parent.parent / "runs" / f"{cik}_{fy_end}.json"
    out.write_text(json.dumps({"cik": cik, "company": name, "fy_end": fy_end, "model": MODEL, "evidence": items,
                               "samples": samples, "agreement": agreement}, indent=2))
    print(f"== saved {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
