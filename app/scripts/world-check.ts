import { WorldEvidenceStore } from '../src/memory/world.ts';
import { caseId, recordedCases } from '../src/cases.ts';
import { CsvSource } from '../src/data/source.ts';
import { evidencePack } from '../src/agent/evidence.ts';

async function main(): Promise<void> {
  const mutate = process.argv.includes('--mutate');
  const source = new CsvSource();
  const runs = await recordedCases();
  const targetRun = runs.find((r) => r.cik === 1336917 && r.fy_end === '2015-12-31') ?? runs[0];
  const id = caseId(targetRun.cik, targetRun.fy_end);
  const pack = await evidencePack(source, targetRun.cik, targetRun.fy_end);

  const clock = () => new Date('2026-10-26T12:00:00.000Z');
  const store = new WorldEvidenceStore({ clock });

  const r1 = await store.ingest(targetRun, pack);
  const shape1 = store.world(id).stateShapeCanonical();
  const events1 = store.world(id).events().length;
  console.log(`run 1: case=${r1.caseId} processed=${r1.processed} changed=${r1.changed} events=${events1}`);

  const secondRun = mutate
    ? structuredClone(targetRun)
    : targetRun;

  if (mutate) {
    secondRun.samples[0].investigator.findings[0].management_says += ' (mutated)';
  }

  const r2 = await store.ingest(secondRun, pack);
  const shape2 = store.world(id).stateShapeCanonical();
  const events2 = store.world(id).events().length;
  console.log(`run 2: case=${r2.caseId} processed=${r2.processed} skipped=${r2.skippedUnchanged} changed=${r2.changed} events=${events2}`);

  if (shape1 === shape2) {
    console.log('diff: empty');
    if (mutate) {
      console.error('expected mutation to change state shape; it did not');
      process.exit(1);
    }
    process.exit(0);
  } else {
    console.log('diff: NON-EMPTY');
    process.exit(mutate ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
