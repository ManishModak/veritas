"""Unit tests for agent/shifted_control.py transformations.

Run with: python3 -I agent/test_shifted_control.py
"""
import re
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shifted_control
import spike


class TestShiftedControl(unittest.TestCase):
    """Test suite verifying year shifting, amount scaling, and identifier masking."""

    def test_amount_scaling_examples(self) -> None:
        """Verify brief examples and edge cases for amount scaling."""
        cases = [
            ("$3,963.3M", "$5,429.7M"),
            ("$659.3 million", "$903.2 million"),
            ("$1.2 billion", "$1.6 billion"),
            ("$90.8M", "$124.4M"),
            ("$-44.6M", "$-61.1M"),
            ("($0.2) million", "($0.3) million"),
            ("($1,000)", "($1,370)"),
            ("$800,000", "$1,096,000"),
            ("$10 million", "$13.7 million"),
            ("$165 million", "$226.1 million"),
        ]
        masks = shifted_control.MASKS[1376339]
        for inp, expected in cases:
            out = shifted_control.transform_text(inp, masks, 1376339)
            self.assertEqual(out, expected, f"Failed scaling for {inp}: got {out}, expected {expected}")

    def test_scale_free_metrics_untouched(self) -> None:
        """Verify percentages, DSO days, ratios, and Beneish indices are not scaled."""
        text = ("Revenue growth 35.7% vs receivables growth 51.6%; days sales outstanding 53 -> 59 days. "
                "Current ratio decreased to 3.6. Beneish M-score = -1.5222 (flag threshold -1.78; flagged=True). "
                "Indices: DSRI=1.1174 GMI=0.9558 AQI=0.7747 SGI=1.3571 DEPI=0.978 SGAI=0.7804 TATA=0.1344 LVGI=1.0568")
        masks = shifted_control.MASKS[1375365]
        out = shifted_control.transform_text(text, masks, 1375365)
        self.assertEqual(out, text)

    def test_year_shifting(self) -> None:
        """Verify years in 2000-2029 are shifted by +7 while historical citations remain untouched."""
        text = "In fiscal 2015 and 2014, ending 2015-06-30. Commenced operations in 1993. Citation (Beneish 1999)."
        masks = shifted_control.MASKS[1375365]
        out = shifted_control.transform_text(text, masks, 1375365)
        expected = "In fiscal 2022 and 2021, ending 2022-06-30. Commenced operations in 1993. Citation (Beneish 1999)."
        self.assertEqual(out, expected)

    def test_identifier_neutralization(self) -> None:
        """Verify accession numbers, URLs, and CIKs are neutralized."""
        text = "Source: 10-K accession 0001376339-15-000040, filed 2015-03-13"
        out = shifted_control.transform_text(text, shifted_control.MASKS[1376339], 1376339)
        self.assertEqual(out, "Source: 10-K filing, filed 2022-03-13")

        quarter_src = "10-Q/10-K accessions 0001445305-14-004894, 0001445305-14-004894 (and prior-year 0001445305-13-002839)"
        out_q = shifted_control.transform_text(quarter_src, shifted_control.MASKS[1375365], 1375365)
        self.assertEqual(out_q, "10-Q/10-K filing")

        mdna_src = "10-K MD&A, https://www.sec.gov/Archives/edgar/data/1375365/000162828015007025/smci-2015630x10k.htm"
        out_m = shifted_control.transform_text(mdna_src, shifted_control.MASKS[1375365], 1375365)
        self.assertEqual(out_m, "10-K MD&A, 10-K filing")

    def test_transform_all_cases(self) -> None:
        """Run full transformation assertions across all 3 test cases."""
        cases = [
            (1376339, "2015-12-31"),
            (1375365, "2015-06-30"),
            (320187, "2015-05-31"),
        ]
        for cik, fy in cases:
            name, items, orig_facts, masks = shifted_control.transform_evidence(cik, fy)
            self.assertTrue(len(items) > 0)
            # Check date consistency between Q4 and FY end
            # Find Q4 signal and fact FY end
            fy_ends = [it["text"] for it in items if it["kind"] == "fact" and "revenue for fiscal year ending" in it["text"]]
            self.assertTrue(any(re.search(r"ending 2022-", t) for t in fy_ends))


if __name__ == "__main__":
    unittest.main()
