"""Shifted control: does the verdict survive when company names, years, and amounts are all transformed?

Reruns spike.run_once on an evidence pack with:
- company names and flagship product names masked ("the Company", "Product A"...)
- years shifted by +7 (2000-2029) everywhere so dates and fiscal-year text line up
- currency amounts scaled by 1.37 keeping units and reasonable decimals
- accession numbers, CIKs, and URLs replaced with neutral text ("10-K filing")

Saves to ../runs/anon/<cik>_<fy_end>_shifted.json with agreement, in the spike.py run format.

Usage: NVIDIA_API_KEY=... python3 -I agent/shifted_control.py <cik> <fy_end> [samples=3]
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spike

YEAR_SHIFT = 7
AMOUNT_SCALE = 1.37

MASKS = {  # per company: (pattern, replacement), applied case-insensitively in order
    1376339: [
        (r"MiMedx(?: Group)?(?:, Inc\.)?", "the Company"),
        (r"EpiFix", "Product A"),
        (r"AmnioFix", "Product B"),
    ],
    1375365: [
        (r"Super ?Micro(?: Computer)?(?:, Inc\.)?", "the Company"),
        (r"Supermicro", "the Company"),
        (r"SMCI", "the Company"),
    ],
    320187: [
        (r"\bNike(?:, Inc\.)?['’]s\b", "the Company's"),
        (r"\bNike(?:, Inc\.)?\b", "the Company"),
        (r"\bJordan(?: Brand)?\b", "Product B"),
        (r"\bConverse\b", "Product A"),
    ],
}

AMOUNT_RE = re.compile(
    r'(?P<pre>\(?\s*-?\s*\$\s*-?\s*)(?P<num>[\d,]+(?:\.\d+)?)(?P<post>\s*\)?)(?P<unit>\s*(?:thousand|million|billion|trillion|[kKmMbB]))?'
)


def scale_amount_match(m: re.Match) -> str:
    """Scale a matched currency amount by F=1.37, preserving unit and decimal precision."""
    pre = m.group("pre")
    num_str = m.group("num").replace(",", "")
    post = m.group("post")
    unit = m.group("unit") or ""
    val = float(num_str) * AMOUNT_SCALE
    has_unit = bool(unit.strip())
    if has_unit or "." in m.group("num"):
        scaled_str = f"{val:,.1f}"
    else:
        scaled_str = f"{round(val):,}"
    return f"{pre}{scaled_str}{post}{unit}"


def shift_year_match(m: re.Match) -> str:
    """Add K=7 to years in range 2000-2029."""
    val = int(m.group(1))
    if 2000 <= val <= 2029:
        return str(val + YEAR_SHIFT)
    return m.group(1)


def transform_text(text: str, masks: list[tuple[str, str]], cik: int) -> str:
    """Transform text: neutralise identifiers, apply name masks, scale currency amounts, and shift years."""
    # 1. Identifiers
    text = re.sub(r"https://\S+", "10-K filing", text)
    text = re.sub(r"10-K accession [^,]+,\s*filed", "10-K filing, filed", text)
    text = re.sub(r"10-Q/10-K accessions .*", "10-Q/10-K filing", text)
    text = re.sub(r"\b\d{10}-\d{2}-\d{6}\b", "10-K filing", text)
    text = re.sub(rf"\b0*{cik}\b", "the Company", text)

    # 2. Name masks
    for pat, rep in masks:
        text = re.sub(pat, rep, text, flags=re.I)

    # 3. Currency amounts ($...)
    text = AMOUNT_RE.sub(scale_amount_match, text)

    # 4. Years (2000-2029 -> +7)
    text = re.sub(r"(?<![\$\d,])\b(20\d\d)\b", shift_year_match, text)

    return text


def transform_evidence(cik: int, fy_end: str) -> tuple[str, list[dict], list[dict], list[tuple[str, str]]]:
    """Load and transform evidence pack; return (company_name, transformed_items, orig_facts, masks)."""
    name, items = spike.evidence_pack(cik, fy_end)
    masks = MASKS[cik]
    orig_facts = [dict(it) for it in items if it["kind"] == "fact"]

    for it in items:
        it["text"] = transform_text(it["text"], masks, cik)
        it["source"] = transform_text(it["source"], masks, cik)

    # Assert 1: no masked name remains
    for it in items:
        full = it["text"] + " " + it["source"]
        for pat, _ in masks:
            assert not re.search(pat, full, re.I), f"Mask leftover in {it['id']}: {pat} found in {full}"

    # Assert 2: no original year 2010-2019 remains anywhere in the pack
    for it in items:
        full = it["text"] + " " + it["source"]
        years = re.findall(r"\b(201\d)\b", full)
        assert not years, f"Year 2010-2019 leftover in {it['id']}: {years} in {full}"

    # Assert 3: for every fact item, scaled amount equals F times original within rounding
    fact_items = [it for it in items if it["kind"] == "fact"]
    for orig_it, trans_it in zip(orig_facts, fact_items):
        m_orig = AMOUNT_RE.search(orig_it["text"])
        m_trans = AMOUNT_RE.search(trans_it["text"])
        assert m_orig and m_trans, f"Missing amount in fact {orig_it['id']}"
        val_orig = float(m_orig.group("num").replace(",", ""))
        val_trans = float(m_trans.group("num").replace(",", ""))
        diff = abs(val_trans - val_orig * AMOUNT_SCALE)
        assert diff <= 0.06, f"Fact scale mismatch in {orig_it['id']}: orig={val_orig}, scaled={val_trans}, diff={diff}"

    # Clean check: no accessions or CIKs remain
    for it in items:
        full = it["text"] + " " + it["source"]
        assert not re.search(r"\b\d{10}-\d{2}-\d{6}\b", full), f"Accession leftover in {it['id']}: {full}"
        assert str(cik) not in full, f"CIK leftover in {it['id']}: {full}"

    return name, items, orig_facts, masks


def main() -> None:
    cik, fy_end = int(sys.argv[1]), sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    name, items, orig_facts, masks = transform_evidence(cik, fy_end)

    pack = "\n".join(f"[{it['id']}] ({it['kind']}) {it['text']}  -- source: {it['source']}" for it in items)
    head = f"Company: (anonymized)\nEvidence pack:\n{pack}"
    print(f"== {name} FY ending {fy_end} (shifted K={YEAR_SHIFT}, F={AMOUNT_SCALE}): {len(items)} evidence items, target {n} samples", file=sys.stderr)

    out = Path(__file__).resolve().parent.parent / "runs" / "anon" / f"{cik}_{fy_end}_shifted.json"
    out.parent.mkdir(exist_ok=True)
    samples: list[dict] = []
    if out.exists():
        try:
            prev = json.loads(out.read_text())
            if isinstance(prev.get("samples"), list):
                samples = prev["samples"]
                print(f"== Loaded {len(samples)} existing samples from {out}", file=sys.stderr)
        except Exception as e:
            print(f"== Warning: could not parse existing file {out}: {e}", file=sys.stderr)

    ids = {it["id"] for it in items}
    while len(samples) < n:
        idx = len(samples) + 1
        print(f"== [{name} {fy_end}] Running sample {idx} of {n}...", file=sys.stderr)
        s = spike.run_once(head, ids)
        samples.append(s)
        agreement = {stage: dict(Counter(sam[stage].get(key, "?") for sam in samples))
                     for stage, key in (("investigator", "verdict"), ("judge", "final_verdict"))}
        print(f"== {name} {fy_end} shifted agreement ({len(samples)}/{n}): {json.dumps(agreement)}", file=sys.stderr)
        out.write_text(json.dumps({
            "cik": cik,
            "company": name,
            "fy_end": fy_end,
            "anonymized": True,
            "year_shift": YEAR_SHIFT,
            "amount_scale": AMOUNT_SCALE,
            "masks": masks,
            "model": spike.MODEL,
            "evidence": items,
            "samples": samples,
            "agreement": agreement,
        }, indent=2))
        print(f"== saved sample {len(samples)} to {out}", file=sys.stderr)

    final_agreement = {stage: dict(Counter(sam[stage].get(key, "?") for sam in samples[:n]))
                       for stage, key in (("investigator", "verdict"), ("judge", "final_verdict"))}
    print(f"== Completed {name} {fy_end} {n} samples. Agreement: {json.dumps(final_agreement)}", file=sys.stderr)


if __name__ == "__main__":
    main()
