import test from 'node:test';
import assert from 'node:assert/strict';
import { ZetarisSource, normalizeRows } from '../src/data/zetaris.ts';
import { CsvSource } from '../src/data/source.ts';
import { evidencePack } from '../src/agent/evidence.ts';
import { recordedCases } from '../src/cases.ts';
import { cohortQuery, query } from '../src/data/queries.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../src/paths.ts';

if(!process.env.ZETARIS_BRIDGE_URL)throw new Error('Set ZETARIS_BRIDGE_URL to the real bridge for this opt-in integration check');
const source=new ZetarisSource(),csv=new CsvSource();
test('real bridge synthetic DEPI=1.0 literal retains Python float spelling',{timeout:120000},async()=>{
  const response=await fetch(process.env.ZETARIS_BRIDGE_URL!.replace(/\/$/,'')+'/sql',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql:'SELECT 1.0 AS depi'}),signal:AbortSignal.timeout(60000),
  });
  assert.equal(response.status,200);
  const payload=await response.json() as {columns:string[];rows:unknown[][]};
  assert.equal(normalizeRows('beneish',payload.columns,payload.rows)[0].depi,'1.0');
});
for(const run of await recordedCases())test(`real Zetaris exact evidence parity: ${run.cik}_${run.fy_end}`,{timeout:120000},async()=>{
  const pack=await evidencePack(source,run.cik,run.fy_end);
  assert.deepEqual(pack.evidence,run.evidence);assert.deepEqual(pack.evidence,(await evidencePack(csv,run.cik,run.fy_end)).evidence);
  assert(Object.values(pack.origins).every(o=>o.queries.every(q=>q.mode==='zetaris')));
});
test('real typed DSRI=0.0 and federated industries preserve missing Arista',{timeout:120000},async()=>{
  const row=(await source.execute(query('beneish',1376339,'2018-12-31'))).rows[0];assert.equal(row.dsri,'0.0');
  assert.deepEqual(row,(await csv.execute(query('beneish',1376339,'2018-12-31'))).rows[0]);
  // The shared database may also hold companies added in the app; count only the cohort's own.
  const cohortCiks=new Set(JSON.parse(await readFile(join(ROOT,'data/cohort.json'),'utf8')).companies.map((c:{cik:number})=>String(c.cik)));
  const joined={rows:(await source.execute(cohortQuery())).rows.filter(r=>cohortCiks.has(r.cik))};
  assert.equal(joined.rows.length,148);
  assert(joined.rows.some(r=>r.cik==='1596532'&&r.industry===''));
  assert(joined.rows.some(r=>r.cik==='1336917'&&r.industry.length>0));
  console.log('Real federation:',JSON.stringify({companyYears:joined.rows.length,named:joined.rows.filter(r=>r.industry).length,aristaRowsPreserved:joined.rows.filter(r=>r.cik==='1596532').length}));
});
