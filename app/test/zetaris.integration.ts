import test from 'node:test';
import assert from 'node:assert/strict';
import { ZetarisSource } from '../src/data/zetaris.ts';
import { CsvSource } from '../src/data/source.ts';
import { evidencePack } from '../src/agent/evidence.ts';
import { recordedCases } from '../src/cases.ts';
import { cohortQuery, query } from '../src/data/queries.ts';

if(!process.env.ZETARIS_BRIDGE_URL)throw new Error('Set ZETARIS_BRIDGE_URL to the real bridge for this opt-in integration check');
const source=new ZetarisSource(),csv=new CsvSource();
for(const run of await recordedCases())test(`real Zetaris exact evidence parity: ${run.cik}_${run.fy_end}`,{timeout:120000},async()=>{
  const pack=await evidencePack(source,run.cik,run.fy_end);
  assert.deepEqual(pack.evidence,run.evidence);assert.deepEqual(pack.evidence,(await evidencePack(csv,run.cik,run.fy_end)).evidence);
  assert(Object.values(pack.origins).every(o=>o.queries.every(q=>q.mode==='zetaris')));
});
test('real typed DSRI=0.0 and federated industries preserve missing Arista',{timeout:120000},async()=>{
  const row=(await source.execute(query('beneish',1376339,'2018-12-31'))).rows[0];assert.equal(row.dsri,'0.0');
  assert.deepEqual(row,(await csv.execute(query('beneish',1376339,'2018-12-31'))).rows[0]);
  const joined=await source.execute(cohortQuery());
  assert.equal(joined.rows.length,148);
  assert(joined.rows.some(r=>r.cik==='1596532'&&r.industry===''));
  assert(joined.rows.some(r=>r.cik==='1336917'&&r.industry.length>0));
  console.log('Real federation:',JSON.stringify({companyYears:joined.rows.length,named:joined.rows.filter(r=>r.industry).length,aristaRowsPreserved:joined.rows.filter(r=>r.cik==='1596532').length}));
});
