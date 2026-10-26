import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { WorldEvidenceStore } from '../src/memory/world.ts';
import { caseId, recordedCases } from '../src/cases.ts';
import { CsvSource } from '../src/data/source.ts';
import { evidencePack } from '../src/agent/evidence.ts';
import type { CaseRun } from '../src/agent/types.ts';

const source = new CsvSource();
const runs = await recordedCases();
const packs = new Map(await Promise.all(
  runs.map(async (r) => [caseId(r.cik, r.fy_end), await evidencePack(source, r.cik, r.fy_end)] as const)
));
const clock = () => new Date('2026-10-26T12:00:00.000Z');

test('WorldEvidenceStore ingests all 11 recorded cases with computed CsvSource packs and is strictly idempotent on re-ingest', async () => {
  const store = new WorldEvidenceStore({ clock });
  const shapes = new Map<string, string>();
  const eventCounts = new Map<string, number>();

  // Milestone 2.1: First ingest of all 11 cases
  for (const run of runs) {
    const id = caseId(run.cik, run.fy_end);
    const pack = packs.get(id)!;
    const res = await store.ingest(run, pack);

    assert.equal(res.caseId, id);
    assert.equal(res.changed, true, `First ingest of ${id} must report changed: true`);
    assert.equal(res.processed, pack.evidence.length);
    assert.equal(res.skippedUnchanged, 0);

    const world = store.world(id);
    const shape = world.stateShapeCanonical();
    assert(shape.length > 0);
    shapes.set(id, shape);
    eventCounts.set(id, world.events().length);
  }

  // Milestone 2.2: Re-ingest all 11 cases and verify empty diff + no duplicate events
  for (const run of runs) {
    const id = caseId(run.cik, run.fy_end);
    const pack = packs.get(id)!;
    const res = await store.ingest(run, pack);

    assert.equal(res.caseId, id);
    assert.equal(res.changed, false, `Re-ingest of ${id} must report changed: false`);
    assert.equal(res.processed, 0);
    assert.equal(res.skippedUnchanged, pack.evidence.length);

    const world = store.world(id);
    const shapeAfter = world.stateShapeCanonical();
    assert.equal(shapeAfter, shapes.get(id), `State shape diff for ${id} must be empty`);
    assert.equal(world.events().length, eventCounts.get(id), `Event count for ${id} must not increase`);
  }
});

test('source chain accuracy, SEC URLs, input row preservation and multiple citations reachable', async () => {
  const store = new WorldEvidenceStore({ clock });
  const uaRun = runs.find((r) => r.cik === 1336917 && r.fy_end === '2015-12-31')!;
  const uaId = caseId(uaRun.cik, uaRun.fy_end);
  const uaPack = packs.get(uaId)!;
  await store.ingest(uaRun, uaPack);

  // 1. Fact evidence provenance: prior year fact must preserve prior filing date & accession
  const e1 = uaPack.evidence.find((e) => e.kind === 'fact' && e.text.includes('2014-12-31'))!;
  const provE1 = store.provenance(uaId, e1.id);
  assert.equal(provE1.company.attrs.company, 'Under Armour');
  assert.equal(provE1.company.attrs.cik, 1336917);
  assert.equal(provE1.evidence.id, e1.id);
  assert.equal(provE1.evidence.kind, 'fact');
  assert.deepEqual(provE1.origins, uaPack.origins[e1.id], 'Origins must match CsvSource pack exactly');

  // Must preserve original accession and not attribute to current 10-K
  const priorFiling = provE1.filings.find((f) => f.attrs.accn === '0001336917-15-000006');
  assert(priorFiling, 'Prior-year fact must link to 2014 filing accession 0001336917-15-000006');
  assert.equal(priorFiling.attrs.filed, '2015-02-20');
  assert((priorFiling.attrs.url as string).includes('/000133691715000006/0001336917-15-000006-index.htm'), 'SEC archive URL built from accession');

  // 2. Current year fact evidence
  const eCur = uaPack.evidence.find((e) => e.kind === 'fact' && e.text.includes('2015-12-31'))!;
  const provCur = store.provenance(uaId, eCur.id);
  const curFiling = provCur.filings.find((f) => f.attrs.accn === uaPack.filing.accn);
  assert(curFiling, 'Current fact must link to current 10-K filing');
  assert.equal(curFiling.attrs.filed, uaPack.filing.filed);
  assert.equal(curFiling.attrs.url, uaPack.filing.url, 'Exact MD&A document URL must be used when matched');

  // 3. Computed signal evidence carries all actual input rows and corresponding filings
  const sig = uaPack.evidence.find((e) => e.kind === 'signal' && e.text.includes('Revenue growth'))!;
  const provSig = store.provenance(uaId, sig.id);
  assert(provSig.origins.rows.length >= 2, 'Signal must carry all actual input rows');
  assert(provSig.filings.length >= 2, 'Signal must link to both prior and current filings');
  assert(provSig.filings.some((f) => f.attrs.accn === '0001336917-15-000006'));
  assert(provSig.filings.some((f) => f.attrs.accn === uaPack.filing.accn));
  const signalNode=store.world(uaId).view('graph').query({type:'evidence',where:e=>e.attrs.evidenceId===sig.id})[0];
  assert.equal(signalNode.source.at,`${uaPack.filing.filed}T00:00:00.000Z`);
  assert.equal(signalNode.source.url,uaPack.filing.url);

  // 4. MD&A evidence provenance
  const mdna = uaPack.evidence.find((e) => e.kind === 'mdna')!;
  const provMdna = store.provenance(uaId, mdna.id);
  assert.equal(provMdna.evidence.kind, 'mdna');
  assert.equal(provMdna.filings[0].attrs.url, uaPack.filing.url);

  // 5. Findings and rulings chain connected via finding_index
  const citedEv = uaRun.samples.flatMap((s) => s.investigator.findings).flatMap((f) => f.evidence);
  const mostCitedId = [...new Set(citedEv)].sort(
    (a, b) => citedEv.filter((x) => x === b).length - citedEv.filter((x) => x === a).length
  )[0];

  const provMulti = store.provenance(uaId, mostCitedId);
  assert(provMulti.findings.length > 0, 'Must have at least one finding citing this evidence');
  for (const finding of provMulti.findings) {
    const sIdx = finding.attrs.sampleIndex as number;
    const fIdx = finding.attrs.findingIndex as number;
    assert((finding.attrs.evidence as string[]).includes(mostCitedId));
    // Verify corresponding ruling joined by finding_index
    const matchingRuling = provMulti.rulings.find(
      (r) => (r.attrs.sampleIndex as number) === sIdx && (r.attrs.finding_index as number) === fIdx
    );
    assert(matchingRuling, `Ruling for sample ${sIdx} finding_index ${fIdx} must be joined`);
  }

  // 6. Relationships graph includes the complete chain: company -> filing -> evidence -> finding -> ruling
  const relTypes = new Set(provMulti.relationships.map((r) => r.type));
  assert(relTypes.has('filed'), 'Must have company -> filing relationships');
  assert(relTypes.has('supports'), 'Must have filing -> evidence and evidence -> finding relationships');
  assert(relTypes.has('ruled'), 'Must have finding -> ruling relationships');

  // 7. Ground truth isolation: role and enforcement must never enter the graph
  const canonical = store.world(uaId).stateShapeCanonical();
  assert(!canonical.includes('"role"'), 'role ground truth must not enter canonical graph');
  assert(!canonical.includes('"enforcement"'), 'enforcement ground truth must not enter canonical graph');
  assert(!JSON.stringify(provMulti).includes('"role"'), 'role must not enter provenance');
  assert(!JSON.stringify(provMulti).includes('"enforcement"'), 'enforcement must not enter provenance');
});

test('changed run produces distinct active revision, retains audit history, and older recordings never overwrite live evidence', async () => {
  const store = new WorldEvidenceStore({ clock });
  const smRun = runs.find((r) => r.cik === 1375365 && r.fy_end === '2015-06-30')!;
  const smId = caseId(smRun.cik, smRun.fy_end);
  const smPack = packs.get(smId)!;

  // 1. Ingest original recorded run
  const res1 = await store.ingest(smRun, smPack);
  assert.equal(res1.changed, true);
  const origEventsCount = store.world(smId).events().length;
  const origAuditCount = store.world(smId).audit().length;
  const recordedRevision=store.provenance(smId,'E1').company.attrs.activeRevision as string;

  // 2. Ingest modified run with changed finding
  const modifiedRun: CaseRun = structuredClone(smRun);
  modifiedRun.samples[0].investigator.findings[0].management_says = 'Super Micro claims inventory growth reflects impending enterprise product surge.';
  const res2 = await store.ingest(modifiedRun, smPack);

  assert.equal(res2.changed, true, 'Changed run must report changed: true');
  const world = store.world(smId);
  assert(world.events().length > origEventsCount, 'Earlier events must be retained and new events appended');
  assert(world.audit().length > origAuditCount, 'Earlier audit must be retained and new audit appended');

  // Active revision must now point to the modified run
  const provMod = store.provenance(smId, 'E1');
  assert.equal(
    provMod.findings[0]?.attrs.management_says,
    'Super Micro claims inventory growth reflects impending enterprise product surge.',
    'Active revision must return the changed finding text'
  );

  // 3. Re-ingesting modified run must be idempotent
  const shapeModBefore = world.stateShapeCanonical();
  const res2Again = await store.ingest(modifiedRun, smPack);
  assert.equal(res2Again.changed, false);
  assert.equal(world.stateShapeCanonical(), shapeModBefore, 'Re-ingest of modified run must produce empty diff');

  // 4. Ingesting older recording must NOT overwrite live evidence on a read
  const resOld = await store.ingest(smRun, smPack);
  const provAfterOldIngest = store.provenance(smId, 'E1');
  assert.equal(
    provAfterOldIngest.findings[0]?.attrs.management_says,
    'Super Micro claims inventory growth reflects impending enterprise product surge.',
    'Older recording must never overwrite live evidence on a read'
  );
  assert.notEqual(store.provenance(smId,'E1',recordedRevision).findings[0]?.attrs.management_says,'Super Micro claims inventory growth reflects impending enterprise product surge.');
  assert.throws(()=>store.provenance(smId,'E1','unknown'),/Unknown revision/);
});

test('unknown citations are rejected before any graph records are created',async()=>{
  const store=new WorldEvidenceStore({clock}),run=structuredClone(runs[0]),id=caseId(run.cik,run.fy_end);
  run.samples[0].judge.rulings[0].evidence.push('E99999');
  await assert.rejects(store.ingest(run,packs.get(id)!),/Citation check failed/);
  assert.throws(()=>store.world(id),/Unknown case/);
});

test('optional saved live run ingests as a distinct revision', async (t) => {
  const livePath = process.env.VERITAS_LIVE_FIXTURE;
  if (!livePath) { t.skip('Set VERITAS_LIVE_FIXTURE to a saved live JSON artifact to run this check'); return; }

  const liveRun: CaseRun = JSON.parse(await readFile(livePath, 'utf8'));
  const smId = caseId(liveRun.cik, liveRun.fy_end);
  const smPack = packs.get(smId)!;

  const store = new WorldEvidenceStore({ clock });
  const smRun = runs.find((r) => r.cik === 1375365 && r.fy_end === '2015-06-30')!;

  // First ingest recorded run
  await store.ingest(smRun, smPack);
  const provRec = store.provenance(smId, 'E13');

  // Next ingest the actual live run from M2
  const resLive = await store.ingest(liveRun, smPack);
  assert.equal(resLive.changed, true);

  const provLive = store.provenance(smId, 'E13');
  assert(provLive.findings.length > 0, 'Live run must have findings citing E13');
  assert.notEqual(
    JSON.stringify(provLive.findings[0].attrs.management_says),
    JSON.stringify(provRec.findings[0].attrs.management_says),
    'Live run must produce distinct findings from the recorded baseline'
  );
});

test('unknown case and unknown evidence throw explicit errors', async () => {
  const store = new WorldEvidenceStore({ clock });
  const uaRun = runs.find((r) => r.cik === 1336917 && r.fy_end === '2015-12-31')!;
  const uaId = caseId(uaRun.cik, uaRun.fy_end);
  await store.ingest(uaRun, packs.get(uaId)!);

  assert.throws(() => store.world('unknown_case'), /Unknown case: unknown_case/);
  assert.throws(() => store.provenance('unknown_case', 'E1'), /Unknown case: unknown_case/);
  assert.throws(() => store.provenance(uaId, 'E999'), /Unknown evidence: E999/);
});

test('persistence with directory option saves and reloads state across instances', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'veritas-world-store-'));
  const store1 = new WorldEvidenceStore({ directory: dir, clock });
  const uaRun = runs.find((r) => r.cik === 1336917 && r.fy_end === '2015-12-31')!;
  const uaId = caseId(uaRun.cik, uaRun.fy_end);
  const uaPack = packs.get(uaId)!;

  await store1.ingest(uaRun, uaPack);
  const prov1 = store1.provenance(uaId, 'E1');

  assert(existsSync(join(dir, '.world', `${uaId}.json`)), '.world/<caseId>.json file must exist on disk');

  // Create fresh store pointing to the same directory
  const store2 = new WorldEvidenceStore({ directory: dir, clock });
  const prov2 = store2.provenance(uaId, 'E1');

  assert.equal(prov2.evidence.id, 'E1');
  assert.equal(prov2.company.attrs.company, 'Under Armour');
  assert.equal(prov2.filings[0].attrs.accn, prov1.filings[0].attrs.accn);
  assert.deepEqual(prov2.origins, prov1.origins);
  assert.equal(prov2.findings.length, prov1.findings.length);
  assert.equal(prov2.rulings.length, prov1.rulings.length);
  assert.equal(prov2.relationships.length, prov1.relationships.length);
  assert.equal(store2.world(uaId).events().length, store1.world(uaId).events().length);
  assert.equal(store2.world(uaId).audit().length, store1.world(uaId).audit().length);
  const before=store2.world(uaId).stateShapeCanonical(), count=store2.world(uaId).events().length;
  assert.equal((await store2.ingest(uaRun,uaPack)).changed,false);
  assert.equal(store2.world(uaId).stateShapeCanonical(),before);
  assert.equal(store2.world(uaId).events().length,count);
});

test('provenance mode changes produce a revision even with identical evidence; concurrent replay stays idempotent',async()=>{
  const run=runs[0], id=caseId(run.cik,run.fy_end), pack=packs.get(id)!;
  const store=new WorldEvidenceStore({clock});
  const first=await Promise.all([store.ingest(run,pack),store.ingest(run,pack)]);
  assert.deepEqual(first.map(r=>r.changed),[true,false]);
  const zetaris=structuredClone(pack);
  for(const origin of Object.values(zetaris.origins)) for(const q of origin.queries){q.mode='zetaris';q.label='executed on Zetaris';}
  assert.equal((await store.ingest(run,zetaris)).changed,true);
  assert(store.provenance(id,'E1').origins.queries.every(q=>q.mode==='zetaris'));
  const mismatch=structuredClone(run);mismatch.evidence[0].text='not the source';
  await assert.rejects(store.ingest(mismatch,pack),/differs from the source/);
});

test('live revision pointers survive restart and old recording replay with a later clock',async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),'veritas-world-live-'));
  const run=runs[0],id=caseId(run.cik,run.fy_end),pack=packs.get(id)!;
  const changed=structuredClone(run);changed.samples[0].investigator.findings[0].management_says='changed live statement';
  let now=new Date('2026-10-26T10:00:00Z');
  const store=new WorldEvidenceStore({directory:dir,clock:()=>now});
  await store.ingest(run,pack);
  now=new Date('2026-12-26T10:00:00Z');
  await store.ingest(changed,pack);
  const before=store.world(id).stateShapeCanonical();
  const reloaded=new WorldEvidenceStore({directory:dir,clock:()=>new Date('2027-01-01T00:00:00Z')});
  const activeBefore=reloaded.provenance(id,'E1').company.attrs.activeRevision;
  assert.equal((await reloaded.ingest(run,pack)).changed,false);
  assert.equal(reloaded.provenance(id,'E1').company.attrs.activeRevision,activeBefore);
  assert.equal(reloaded.world(id).stateShapeCanonical(),before);
});
