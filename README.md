# Veritas

**Does management's growth story match the numbers?**

*Open Agent Hackathon 2026 · Track 02: The Agent That Can Explain Why. Built for investors, auditors and journalists, on real, public SEC filings.*

Every 10-K explains why revenue grew. Veritas checks that explanation against the numbers the company first filed with the SEC, and shows:

- which explanations the numbers back up, contradict, or leave unverified
- the evidence behind every statement, down to the SQL row and the filing
- the questions an analyst should ask management

A mismatch is a reason to ask questions, not proof of wrongdoing.

## Quick start

Needs Node.js 26+. No API key needed for the recorded demo.

```bash
npm install
npm run setup
npm start
```

Open http://localhost:8788. You get 11 recorded cases, each run 3 times. The header has a light/dark theme toggle.

To publish a read-only copy of the recorded demo (GitHub Pages or any static host), run `npm run export:static`: it writes `site/` (about 5 MB), and live runs, feedback and search show a "run it locally" note there.

## Check any 10-K filer

Type a ticker (or CIK) and the year its fiscal year ended, e.g. `NVDA` and `2025`. It works for companies that file an original 10-K with XBRL financial data, for fiscal years from 2010 on, with the year before also filed (Veritas compares two years). Veritas:

1. fetches that 10-K's MD&A and the as-first-filed XBRL facts for that year and the year before, straight from SEC EDGAR ([`data/add_company.py`](data/add_company.py));
2. loads them into Zetaris (or the CSV store) and builds the evidence pack;
3. shows the numbers and quarter pattern right away. "Run live" then runs the debate (needs `NVIDIA_API_KEY`).

Takes 10–60 seconds. Added companies persist across restarts and appear at the top of the cohort, outside the benchmark counts.

## How it works

```mermaid
flowchart LR
  SEC[SEC filings<br>as first filed] --> Z[Zetaris SQL]
  Z --> P[Evidence pack<br>E1, E2, ...]
  P --> I[Investigator]
  I --> R[Red-team]
  R --> J[Judge]
  J --> W[World Model<br>provenance]
  J --> H[H-MEM<br>past cases]
  W --> UI[Web app]
  H --> UI
```

1. **Evidence.** Zetaris SQL pulls the first-filed revenue, receivables and cash flow, the quarterly figures and the MD&A text. Each item gets an ID (`E30`).
2. **Investigator.** Lists what management says drove growth, checks each claim against the numbers and writes questions for management.
3. **Red-team.** Argues the strongest innocent explanation for each finding.
4. **Judge.** Rules on each finding and cites the evidence that decides it.
5. **Three runs.** The whole debate runs 3 times, in parallel (a live check takes a few minutes). The app shows agreement ("2 of 3 runs"), not one confident label.

All three roles run on NVIDIA Nemotron 3 Ultra. Every citation is checked against the evidence pack.

## Results

11 company-years. 3 were used to tune the prompts (dev); the other 8 were run blind after the prompts were frozen.

| | Result |
| --- | --- |
| Model calls | 99, with 0 citations to IDs outside the pack |
| Blind SEC-case years | Investigator said "does not fit" on 2 of 4 |
| Blind peers (no SEC case) | Investigator said "does not fit" on 0 of 4 |
| Judge | Mostly "unverified" |

The sample is small and hand-picked, so this is not an accuracy rate.

### Hero case: Under Armour FY2015

- The overall label is "fits" (3 of 3 runs). The agent does not call this a fraud.
- It does find the odd spot: **Q4 receivables grew 55% while revenue grew 31%**, and days sales outstanding rose from 28 to 34 (`E30`).
- All 3 runs ask management about Q4 shipment timing. One asks how much Q4 2015 revenue came from shipments **pulled forward from Q1 2016**.
- In 2021 the [SEC charged Under Armour](https://www.sec.gov/newsroom/press-releases/2021-78) for not disclosing that pulled-forward sales were propping up its growth. The agent never sees the SEC action.

### Disguised controls

Does the model just recognise companies with a later scandal? We reran the two blind hits in disguise, twice:

- **Names masked:** company and product names replaced ("the Company", "Product A").
- **Names, years and amounts:** names masked, every year moved 7 years later, every dollar amount scaled by 1.37. Ratios, growth rates and days are unchanged, so the evidence means the same thing.

| Case | Investigator, named | Names masked | Names, years, amounts |
| --- | --- | --- | --- |
| MiMedx FY2015 | does not fit 3/3 | does not fit 3/3 | does not fit 3/3 |
| Super Micro FY2015 | does not fit 2/3 | does not fit 3/3 | does not fit 2/3 |
| Nike FY2015 (peer, control) | fits 3/3 | — | unverified 2/3, fits 1/3 |

The verdicts held. The Nike control shows the disguise makes the model more cautious but does not invent a mismatch. Every run cited only in-pack IDs. Scripts: [`agent/anon_control.py`](agent/anon_control.py), [`agent/shifted_control.py`](agent/shifted_control.py); results and judge verdicts: [`runs/anon/`](runs/anon/).

### Labels drift between runs

A new live 3-run Super Micro FY2015 analysis said "fits" 2 of 3 times; the recorded one said "does not fit" 2 of 3. That is why the app leads with findings and questions, and shows labels only as agreement.

## Sponsor technology

### Zetaris: one SQL layer over every source

- With a bridge URL set, every data query runs as SQL through Zetaris ([`queries.ts`](app/src/data/queries.ts), [`zetaris.ts`](app/src/data/zetaris.ts)). Without one, the same queries run on the bundled CSVs.
- Five tables (facts, quarters, beneish, mdna_index, mdna_paragraphs) live in Postgres, registered in Zetaris as a JDBC datasource.
- The cohort's industry names come from a **live REST API** (company_dns), joined to the Postgres data in one Zetaris query:

```sql
SELECT b.*, s.name AS industry
FROM veritas_pg.beneish b
LEFT JOIN company_dns.sic_names s ON b.sic = s.code
```

- Every evidence item shows the SQL Zetaris ran and the rows it used.

### Meterless: provenance and memory

- **World Model** ([`world.ts`](app/src/memory/world.ts)) links company → filing → evidence → finding → ruling. Click any evidence ID to see that chain, its SQL and its audit history.
- **H-MEM** ([`cases.ts`](app/src/memory/cases.ts)) recalls similar past cases and stores analyst feedback. It only recalls cases **filed before** the current one, so later filings can't leak in.
- Engines are vendored unchanged under Apache-2.0 ([attribution](app/vendor/README.md)).

### NVIDIA Nemotron

- `nvidia/nemotron-3-ultra-550b-a55b` via NVIDIA NIM plays investigator, red-team and judge.
- Temperature 0.3, up to 16,000 tokens, 3 attempts per call. The model's reasoning text is not saved.

### What is different

- **As-first-filed numbers.** Later restatements are ignored, so the agent sees only what investors saw at the time.
- **Inspectable evidence.** Every claim cites an ID that opens its SQL, rows and filing.
- **No hindsight.** Memory only recalls earlier filings; the SEC outcome is never in the pack.
- **Agreement, not one label.** Each case runs 3 times and shows how often the runs agree.

Cursor was not used.

## Configuration

All settings are environment variables; [`.env.example`](.env.example) lists them with placeholders.

| Setting | Effect |
| --- | --- |
| `ZETARIS_BRIDGE_URL=http://localhost:8787` | Use Zetaris instead of the bundled CSVs |
| `ZETARIS_SCHEMA` | Zetaris schema for the five tables (default `veritas_pg`) |
| `FACTS_SOURCE=csv` or `zetaris` | Force a data source |
| `SAMPLE_MODE=false` + `NVIDIA_API_KEY` | Enable live runs (3 runs = 9 model calls) |
| `PORT` | Server port (default 8788) |
| `VERITAS_STATE_DIR` | Where live results and memory are saved (default `app/.state`) |

Zetaris errors fail loudly; the app never falls back to CSV silently. One case from the command line: `npm run live -- CIK YYYY-MM-DD [samples=1]`.

## Dependencies

| Part | Needs |
| --- | --- |
| App ([`app/`](app/)) | Node.js 26+, `tsx`, TypeScript. No frontend framework |
| Data pipeline ([`data/`](data/)) | Python 3, standard library only. `load_facts.py` builds the facts, quarters and Beneish CSVs; `fetch_mdna.py` extracts MD&A text |
| Reference agent ([`agent/spike.py`](agent/spike.py)) | Python 3 and `NVIDIA_API_KEY`. Produced the recorded runs in [`runs/`](runs/) |
| Zetaris host ([`bridge/`](bridge/)) | Zetaris 2.4.3.1 Docker stack, Postgres 16, Python with JayDeBeApi. `setup_vm.sh` loads the tables and starts the SQL bridge (`POST /sql`, and `POST /load` for added companies) |

## Tests

```bash
npm test              # 65 pass, 1 optional skip
npm run typecheck
ZETARIS_BRIDGE_URL=http://localhost:8787 npm run test:bridge
```

Checked on Oct 26, 2026:

- Evidence computed by the app matches the recorded runs exactly for all 11 cases, from CSV and from real Zetaris.
- The federated join returns 148 company-years: 141 named, 7 Arista rows kept with no industry match.
- Removing the memory's date guard leaks a later filing, and the test catches it.

## Limits

- A valid citation means the ID exists, not that it supports the claim.
- The model may know these companies from training, whatever we mask.
- Beneish M-score is a screening index, not a verdict.
- Local prototype: no login, single user.

## Where the code came from

The Python pipeline, reference agent and recorded runs were built Oct 25–26, 2026, inside the hackathon window. The TypeScript app reuses their frozen prompts and data unchanged. Meterless engine files are copied unchanged from commit `1742dec`.
