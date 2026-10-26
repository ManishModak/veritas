# Veritas

Veritas compares a company's explanation of revenue growth in its 10-K MD&A with as-first-filed SEC XBRL facts, quarterly signals and Beneish screening ratios. The result is an explanation scorecard, source-linked findings and questions for management. A disagreement with management is a reason to investigate, not a finding of wrongdoing.

## Run the recorded demo

Requires Node.js 26 or newer. From this checkout:

```bash
npm install
npm run setup
npm start
```

Open **http://localhost:8788**. The default `SAMPLE_MODE=true` uses 11 recorded cases, with three independent samples per case. It needs no API key, bridge or SEC download. `setup` generates paragraph CSVs from the bundled [11 MD&A source files](app/fixtures/mdna/), preserving paragraph indices and skipped whitespace gaps.

The application uses TypeScript through `tsx`, native Node HTTP/fetch and vanilla HTML/CSS/JS. There is no frontend framework, bundler or CDN. `PORT` changes the localhost port; `VERITAS_STATE_DIR` changes the default `app/.state` directory for saved live runs and H-MEM state.

## How it explains

1. **Investigator:** identifies management explanations, compares them with evidence, assigns finding-level fit labels, and proposes management questions and evidence that would change its assessment.
2. **Red-team defender:** argues the strongest innocent explanation for each finding.
3. **Judge:** evaluates those arguments and rules per finding with supporting evidence IDs.

The four prompt constants are copied verbatim from the frozen [Python reference](agent/spike.py). Structured citation lists are checked against the evidence pack; that check establishes ID validity, not whether the cited text supports the interpretation. Separate `reasoning_content` is excluded from the saved answer.

The UI shows overall labels as agreement across three independent samples, not as a single definitive result. Individual samples retain their finding-level scorecards, rebuttals and rulings. Clicking an evidence ID opens the World Model provenance drawer: filing accession and SEC link, source SQL, input rows used by that evidence, graph relationships and audit events. Historical case-memory citations open the historical case's evidence.

**Hero case: Under Armour FY2015.** The recorded investigator overall label is “explanation fits the numbers” in 3 of 3 samples. Its useful finding is narrower: Q4 receivables grew 55.0% versus revenue growth of 30.8%, with DSO rising from 28 to 34 days (`E30`). The questions ask about shipments pulled forward from Q1 2016. The [SEC later charged Under Armour over misleading revenue-growth disclosures](https://www.sec.gov/newsroom/press-releases/2021-78). That later action is context for evaluating the prototype; it is excluded from the evidence pack and case memory.

## Sponsor technology

### Zetaris: SQL and federation

[`FactsSource`](app/src/data/source.ts) has CSV and [Zetaris](app/src/data/zetaris.ts) implementations. [Centralized queries](app/src/data/queries.ts) select `facts`, `quarters`, `beneish`, `mdna_index` and `mdna_paragraphs` in `ZETARIS_SCHEMA` (default `veritas_pg`). The client sends `POST $ZETARIS_BRIDGE_URL/sql` with `{"sql":"..."}` and accepts `{"columns":[...],"rows":[[...]]}`.

To use a running bridge:

```bash
ZETARIS_BRIDGE_URL=http://localhost:8787 npm start
```

Setting the URL selects Zetaris independently of `SAMPLE_MODE`. `FACTS_SOURCE=csv` forces CSV; `FACTS_SOURCE=zetaris` requires a bridge URL. Bridge errors fail loudly without falling back to CSV. The drawer labels evidence queries “executed on Zetaris” or “equivalent SQL (CSV mode)”. Evidence is loaded and validated at startup; live model runs reuse that evidence snapshot. Real-source startup took about 31 seconds in the reviewed deployment. `/api/health` reports application readiness and source mode, not a fresh bridge connectivity check.

The cohort industry name comes from a federated relational-to-REST join:

```sql
SELECT b.*, s.name AS industry
FROM veritas_pg.beneish b
LEFT JOIN company_dns.sic_names s ON b.sic = s.code
ORDER BY b.cik, b.fy_end
```

`company_dns.sic_names` is a Zetaris view over the live company_dns REST API. The LEFT JOIN retains unmatched Arista SIC 3576 rows. CSV mode leaves industry blank and labels the field “Zetaris only”.

Transport types are normalized once at the source boundary: boolean/string/numeric flags become CSV `True`/`False`, dates remain `YYYY-MM-DD`, and Beneish numbers retain Python float spellings such as `0.0` and `1.0`. Evidence formatting is identical across sources.

### Meterless: provenance and episodic recall

[Vendored Apache-2.0 reference engines](app/vendor/README.md) supply the active storage and retrieval services:

- **World Model:** [`WorldEvidenceStore`](app/src/memory/world.ts) uses ingest, entity upserts, bitemporal relations, graph views and audit history for company → filing → evidence → finding → ruling. Adapter revision identities include the run and its source origins. Re-ingesting the same revision adds no events. The application rebuilds this graph in memory on startup from source data and saved runs.
- **H-MEM:** [`CaseMemory`](app/src/memory/cases.ts) uses `add`, scoped `query`, retrieval traces, storage and `feedback` with the trust ledger. Findings/questions and analyst feedback persist. Before ranking, the adapter admits only other cases whose 10-K filing date is **strictly earlier** than the current case's date. Ground-truth roles and enforcement metadata are excluded.

Retrieval uses the reference's deterministic hash embedder, not neural semantic embeddings. Similarity and confidence scores are not probabilities that a finding is true. Background mining, sleep and dreaming are not used. The as-of guard blocks later filings; it cannot remove historical knowledge already in the LLM's pretraining.

### NVIDIA Nemotron: the three debate roles

All three roles use `nvidia/nemotron-3-ultra-550b-a55b` through NVIDIA NIM's OpenAI-compatible endpoint with native `fetch`, temperature `0.3` and `max_tokens: 16000`. Requests have a five-minute timeout per attempt and at most three attempts, including retries for malformed answer JSON.

```bash
# Supply NVIDIA_API_KEY through your environment or secret manager.
SAMPLE_MODE=false npm start
```

With a key present, the UI runs three independent samples (nine calls) with SSE progress and saves the grounded result. Recorded cohort metrics remain tied to the original benchmark. Live mode restores saved results after restart. Only one live job runs at a time; SSE replay works while that server process remains alive.

For a smaller CLI verification:

```bash
npm run live -- CIK YYYY-MM-DD [samples=1] [output]
```

The CLI defaults to one sample; overall UI agreement uses three. Never commit credentials or captured environment files.

## Verification

```bash
npm test
npm run typecheck
npm run test:parity
npm run test:agent
npm run test:zetaris
ZETARIS_BRIDGE_URL=http://localhost:8787 npm run test:bridge
node --import tsx app/scripts/world-check.ts
node --import tsx app/scripts/world-check.ts --mutate
```

Verified on Oct 26, 2026:

| Check | Result |
| --- | --- |
| Default suite | 56 passed; 1 optional saved-live-fixture test skipped |
| CSV evidence parity | Exact ID/kind/text/source equality for all 11 recorded cases |
| Typed SQLite SQL mock | 16 tests passed, including all 11 evidence packs and source-mutation attacks |
| Real Zetaris bridge | 13 tests passed, including exact parity for all 11 packs |
| Real industry federation | 148 company-years; 141 named; all 7 unmatched Arista rows retained |
| World Model replay | Empty diff; deliberately changed input produces a nonempty diff |
| TypeScript | No diagnostics |

Mock transport tests cover numeric, boolean and string flags, derived Q4, the actual MiMedx FY2018 `DSRI=0.0`, and a **synthetic** `DEPI=1.0` value (no such DEPI row exists in the current dataset). The real bridge suite covers derived Q4, the actual `DSRI=0.0` row and a read-only synthetic `SELECT 1.0 AS depi` wire check. `VERITAS_LIVE_FIXTURE` optionally points the World Model tests at a saved live JSON file; default verification makes no model calls.

## Measured results and limits

The recorded cohort contains three development cases (Under Armour FY2015, Skechers FY2019 and General Mills FY2019) and eight blind cases (four SEC-case company-years and four comparison peers). Across 99 calls there were zero out-of-pack structured citation IDs. The investigator majority said “does not fit” on 2 of 4 blind SEC-case years and 0 of 4 peers. The judge mostly returned “unverified”. Those small, selected denominators are not an accuracy estimate for unseen companies. Roles are hidden in the cohort until explicitly revealed.

A separate live three-sample Super Micro FY2015 run used nine calls: **705,887 ms summed stage time**, 202 structured citations, zero unknown IDs and zero uncited stages. Both investigator and judge said “fits” in 2 of 3 samples, while the original recorded investigator said “does not fit” in 2 of 3. This observed label drift is why the product emphasizes findings, questions and sample agreement. It is not an accuracy improvement.

Other limits: company names can expose historical outcomes through model pretraining; valid citations do not prove semantic support or management intent; Beneish is a screening index; Q4 revenue is sometimes derived; MD&A extraction and concept mapping can lose context. Unknown verdict labels render as supplied. The app is a local research prototype: World Model audit history is rebuilt on boot, job replay is process-local, and it has no multi-user authentication or production deployment layer.

## Component provenance

The [Python spike](agent/spike.py), [data scripts](data/) and recorded runs were developed Oct 25–26, 2026 within the build window. They are the pre-existing reference for this TypeScript application; frozen prompts and financial outputs remain unchanged. Eleven original MD&A source texts are bundled for reproducibility. Meterless source files and licenses were copied unchanged from commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`; [vendor attribution](app/vendor/README.md) identifies the source paths and adapter boundaries.
