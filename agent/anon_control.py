"""Name-masked control: does the verdict survive when the model can't see who the company is?

Reruns spike.run_once on an evidence pack with the company name, aliases and flagship product names
masked ("the Company", "Product A"...), so a verdict can't come from the model recognising the name.
Years and amounts stay visible, so a model that memorised the filings could still identify the firm.
Saves to ../runs/anon/<cik>_<fy_end>_anon.json with agreement, in the spike.py run format.

Usage: NVIDIA_API_KEY=... python3 anon_control.py <cik> <fy_end> [samples=3]
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import spike

MASKS = {  # per company: (pattern, replacement), applied case-insensitively in order
    1376339: [(r"MiMedx(?: Group)?(?:, Inc\.)?", "the Company"), (r"EpiFix", "Product A"), (r"AmnioFix", "Product B")],
    1375365: [(r"Super ?Micro(?: Computer)?(?:, Inc\.)?", "the Company"), (r"Supermicro", "the Company"), (r"SMCI", "the Company")],
}


def main() -> None:
    cik, fy_end = int(sys.argv[1]), sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    name, items = spike.evidence_pack(cik, fy_end)
    masks = MASKS[cik]
    def mask(s: str) -> str:
        for pat, rep in masks:
            s = re.sub(pat, rep, s, flags=re.I)
        return s
    for it in items:
        it["text"], it["source"] = mask(it["text"]), re.sub(r"https://\S+", "10-K filing", mask(it["source"]))
    left = [it["id"] for it in items if re.search(masks[0][0], it["text"] + it["source"], re.I)]
    assert not left, f"unmasked: {left}"
    pack = "\n".join(f"[{it['id']}] ({it['kind']}) {it['text']}  -- source: {it['source']}" for it in items)
    head = f"Company: (anonymized)\nEvidence pack:\n{pack}"
    samples = [spike.run_once(head, {it["id"] for it in items}) for _ in range(n)]
    agreement = {stage: dict(Counter(s[stage].get(key, "?") for s in samples))
                 for stage, key in (("investigator", "verdict"), ("judge", "final_verdict"))}
    print(f"== {name} {fy_end} anonymized agreement: {json.dumps(agreement)}", file=sys.stderr)
    out = Path(__file__).resolve().parent.parent / "runs" / "anon" / f"{cik}_{fy_end}_anon.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"cik": cik, "company": name, "fy_end": fy_end, "anonymized": True, "masks": masks,
                               "model": spike.MODEL, "evidence": items, "samples": samples, "agreement": agreement}, indent=2))


if __name__ == "__main__":
    main()
