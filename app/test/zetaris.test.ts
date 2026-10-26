import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from './mock-bridge.ts';
import { ZetarisSource, normalizeRows, pythonFloat } from '../src/data/zetaris.ts';
import { CsvSource, type FactsSource } from '../src/data/source.ts';
import { query, cohortQuery } from '../src/data/queries.ts';
import { recordedCases } from '../src/cases.ts';
import { evidencePack } from '../src/agent/evidence.ts';
import { AppRuntime } from '../src/runtime.ts';

const bridge=await mockBridge(),source=new ZetarisSource(bridge.url),csv=new CsvSource();
after(()=>bridge.close());
for(const run of await recordedCases())test(`typed SQL bridge computes exact recorded evidence: ${run.cik}_${run.fy_end}`,async()=>{
  const pack=await evidencePack(source,run.cik,run.fy_end);
  assert.deepEqual(pack.evidence,run.evidence);
  assert.deepEqual(pack.evidence,(await evidencePack(csv,run.cik,run.fy_end)).evidence);
  assert(Object.values(pack.origins).every(o=>o.queries.every(q=>q.mode==='zetaris'&&q.label==='executed on Zetaris')));
  assert(!JSON.stringify(pack.origins).includes('"role"'));
  if(run.cik===320187||run.cik===1050797)assert(pack.evidence.some(e=>e.text.includes('Q4 revenue derived as annual minus 9-month YTD')));
});

test('float normalization preserves Python integer/exponent spellings, real DSRI=0.0 and synthetic DEPI=1.0',async()=>{
  assert.equal(pythonFloat(1),'1.0');assert.equal(pythonFloat(0),'0.0');assert.equal(pythonFloat(-0),'-0.0');
  assert.equal(pythonFloat(1e-5),'1e-05');assert.equal(pythonFloat(1e16),'1e+16');assert.equal(pythonFloat(0.0001),'0.0001');
  assert.throws(()=>pythonFloat(Infinity),/Non-finite/);
  const actual=(await source.execute(query('beneish',1376339,'2018-12-31'))).rows;
  assert.deepEqual(actual,(await csv.execute(query('beneish',1376339,'2018-12-31'))).rows);assert.equal(actual[0].dsri,'0.0');
  bridge.db.exec("UPDATE veritas_pg.beneish SET depi=1 WHERE cik=1336917 AND fy_end='2015-12-31'");
  try{
    const expected:FactsSource={async execute(q){const r=await csv.execute(q);if(q.table==='beneish')r.rows=r.rows.map(row=>({...row,depi:'1.0'}));return r;}};
    const pack=await evidencePack(source,1336917,'2015-12-31');
    assert.deepEqual(pack.evidence,(await evidencePack(expected,1336917,'2015-12-31')).evidence);
    assert(pack.evidence.some(e=>e.text.includes('DEPI=1.0')));
  }finally{bridge.db.exec("UPDATE veritas_pg.beneish SET depi="+(await csv.execute(query('beneish',1336917,'2015-12-31'))).rows[0].depi+" WHERE cik=1336917 AND fy_end='2015-12-31'");}
});

test('numeric, boolean and string transport flags all preserve derived-Q4 evidence exactly',async()=>{
  const run=(await recordedCases()).find(r=>r.cik===320187)!;
  try{for(const mode of ['number','boolean','string'] as const){
    bridge.setFlagMode(mode);assert.deepEqual((await evidencePack(source,run.cik,run.fy_end)).evidence,run.evidence);
  }}finally{bridge.setFlagMode('number');}
  const values=[true,false,1,0,'true','false','True','False','1','0'];
  assert.deepEqual(normalizeRows('quarters',['derived'],values.map(v=>[v])).map(r=>r.derived),['True','False','True','False','True','False','True','False','True','False']);
  assert.throws(()=>normalizeRows('quarters',['derived'],[['unexpected']]),/flag value/);
});

test('federated LEFT JOIN retains unmatched Arista and runtime uses industries only in Zetaris mode',async()=>{
  const cohort=await source.execute(cohortQuery());
  assert.equal(cohort.rows.length,148);assert(cohort.rows.some(r=>r.cik==='1596532'&&r.industry===''));
  assert(cohort.rows.some(r=>r.cik==='1336917'&&r.industry==='Apparel'));
  assert((await csv.execute(cohortQuery())).rows.every(r=>r.industry===''));
  const runtime=await AppRuntime.create({source,sampleMode:true,persist:false});
  assert.equal(runtime.dataMode,'zetaris');assert.equal(runtime.list().cases.find(c=>c.cik===1336917)!.industry,'Apparel');
  assert.equal(runtime.list().cases.find(c=>c.cik===1336917)!.industryLabel,'');
  assert.equal(runtime.list().cases.find(c=>c.cik===40704)!.industryLabel,'No industry match');
  assert(bridge.executed.some(sql=>sql===cohortQuery().sql));
});

test('bridge results are computed from SQL, not recorded packs or a CSV fallback',async()=>{
  bridge.db.exec("UPDATE veritas_pg.facts SET value=value*2 WHERE cik=1336917 AND fy_end='2015-12-31' AND concept='revenue'");
  try{const pack=await evidencePack(source,1336917,'2015-12-31');assert(pack.evidence.some(e=>e.text.includes('$7,926.6M')));assert(pack.evidence.some(e=>e.text.includes('Quarterly revenue/receivables data is incomplete')));}
  finally{bridge.db.exec("UPDATE veritas_pg.facts SET value=value/2 WHERE cik=1336917 AND fy_end='2015-12-31' AND concept='revenue'");}
});

test('bridge failures and malformed payloads are loud and do not expose provider bodies or fall back',async()=>{
  const q=query('facts',1336917);
  const unavailable=(async()=>{throw new Error('private-key-value');}) as typeof fetch;
  await assert.rejects(new ZetarisSource('http://mock',{fetch:unavailable}).execute(q),e=>e instanceof Error&&e.message.includes('unavailable')&&!e.message.includes('private-key-value'));
  const invalid=(payload:unknown)=>(async()=>Response.json(payload)) as typeof fetch;
  for(const payload of [{columns:[],rows:[]},{columns:['cik','cik'],rows:[[1,1]]},{columns:['cik'],rows:'bad'}])await assert.rejects(new ZetarisSource('http://mock',{fetch:invalid(payload)}).execute(q),/missing columns|response shape/);
  await assert.rejects(new ZetarisSource('http://mock',{fetch:(async()=>new Response('private-key-value',{status:400})) as typeof fetch}).execute(q),/HTTP 400/);
  assert.throws(()=>normalizeRows('quarters',['derived'],[[true,false]]),/column count/);
  assert.throws(()=>query('facts',1336917,undefined,'invalid; DROP'),/schema/);
});
