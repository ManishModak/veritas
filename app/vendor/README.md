# Meterless reference engines

Veritas vendors selected reference-engine files from the local Meterless checkout at commit **`1742dec56a66e58eef9dda2d2b865823758ca8cd`**:

| Upstream path | Vendored path | License |
| --- | --- | --- |
| `engines/world-model/reference` | [world-model/](world-model/) | [Apache-2.0](world-model/LICENSE) |
| `engines/hmem/reference` | [hmem/](hmem/) | [Apache-2.0](hmem/LICENSE) |

All 16 TypeScript engine source files (six World Model, ten H-MEM) and both license copies are unchanged. Selected upstream documentation, package metadata and the World Model idempotency script accompany them. This directory-level attribution and the application adapters are new Veritas material; the directory is not a copy of the entire upstream repository.

## Services used

[`WorldEvidenceStore`](../src/memory/world.ts) uses `WorldModel.ingest`, entity upserts, bitemporal relationships, graph views and audit history. The adapter constructs the company → filing → evidence → finding → ruling chain, stores source-query origins, and supplies content-addressed run revisions and active/live revision pointers. The evidence drawer reads this graph. The app rebuilds it in memory from canonical inputs and saved runs on startup. Optional reference directory persistence writes synchronously on each event; the app does not enable it.

[`CaseMemory`](../src/memory/cases.ts) uses H-MEM `add`, storage, scoped `query` with retrieval traces, `feedback` and the trust ledger. The adapter filters candidates by the immutable filing catalogue **before ranking**: only other cases filed strictly before the current filing are eligible. It persists the active finding index for feedback alongside H-MEM state under `app/.state/hmem`, or `VERITAS_STATE_DIR/hmem`.

The reference embedder is a deterministic string hash, not a neural semantic model. Veritas does not use mining, sleep or dreaming. Ground-truth cohort roles and enforcement metadata are excluded from graph entities and memory content. These boundaries are application behavior, not modifications to the vendored engines.

## Checks

From the repository root:

```bash
node --import tsx app/scripts/world-check.ts
node --import tsx app/scripts/world-check.ts --mutate
node --import tsx app/vendor/world-model/scripts/idempotency-check.ts
node --import tsx app/vendor/world-model/scripts/idempotency-check.ts --mutate
```

Unchanged replay reports `diff: empty`; deliberate mutation reports `diff: NON-EMPTY`.
