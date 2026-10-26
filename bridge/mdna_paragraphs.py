"""Write data/out/mdna_paragraphs.csv from data/out/mdna/*.txt for loading into Zetaris.

One row per non-empty paragraph: cik, period, para_no, text, url. Paragraphs are split exactly
as agent/spike.py does (text.split("\\n\\n"), stripped); para_no is the 0-based position in that
split, so empty paragraphs leave gaps and order matches the reference.

Usage: python3 -I bridge/mdna_paragraphs.py
"""
import csv
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data/out"

with open(OUT / "mdna_paragraphs.csv", "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["cik", "period", "para_no", "text", "url"])
    n = 0
    for r in csv.DictReader(open(OUT / "mdna/index.csv")):
        for i, p in enumerate((OUT / "mdna" / r["file"]).read_text().split("\n\n")):
            if p.strip():
                w.writerow([r["cik"], r["period"], i, p.strip(), r["url"]]); n += 1
print(f"wrote {n} paragraphs")
