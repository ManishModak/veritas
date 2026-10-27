import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AppRuntime } from '../src/runtime.ts';
import { appServer } from '../src/server.ts';
import { recordedCases } from '../src/cases.ts';
import { INVESTIGATOR, RED_TEAM } from '../src/agent/prompts.ts';
import { CsvSource } from '../src/data/source.ts';

async function serve(runtime:AppRuntime){
  const server=appServer(runtime);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('No test server address');
  return {base:`http://127.0.0.1:${address.port}`,close:async()=>{runtime.shutdown();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
const post=(base:string,url:string,body={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('sample server exposes honest cohort, source-backed drawer, guarded recall, feedback, and explicit errors',{timeout:20000},async()=>{
  const runtime=await AppRuntime.create({source:new CsvSource(),sampleMode:true,persist:false}),server=await serve(runtime),{base}=server;
  try{
    for(const file of ['/','/app.js','/style.css'])assert.equal((await fetch(base+file)).status,200);
    const cohort=await (await fetch(base+'/api/cases')).json();
    assert.equal(cohort.cases.length,11);assert(cohort.cases.every((c:any)=>!Object.hasOwn(c,'role')));
    assert.deepEqual(cohort.results,{calls:99,unknownIds:0,blindFraud:{majorityDoesNotFit:2,total:4},blindPeers:{majorityDoesNotFit:0,total:4}});
    assert(cohort.cases.every((c:any)=>c.industry===''&&c.industryLabel==='Zetaris only'));
    const revealed=await (await fetch(base+'/api/cases?reveal=true')).json();assert.equal(revealed.cases.filter((c:any)=>c.role==='fraud').length,5);
    const id='1336917_2015-12-31',detail=await (await fetch(base+'/api/cases/'+id)).json();
    assert.equal(detail.run.samples.length,3);assert.equal(detail.quarterComparison.length,4);
    assert(detail.memory.memories.every((m:any)=>m.filed<detail.filing.filed));
    for(const eid of ['E1','E25','E30']){
      const provenance=await (await fetch(base+`/api/cases/${id}/evidence/${eid}`)).json();
      assert.equal(provenance.evidence.id,eid);assert(provenance.filings.length>0);
      assert(provenance.origins.queries.every((q:any)=>q.mode==='csv'&&q.label==='equivalent SQL (CSV mode)'&&q.sql.includes('veritas_pg.')));
      assert(provenance.origins.rows.length>0);
    }
    const current=await (await fetch(base+`/api/cases/${id}/memory`)).json();assert(current.memories.every((m:any)=>m.filed<'2016-02-22'));
    assert.equal((await fetch(base+`/api/cases/${id}/memory?asOf=2030-01-01`)).status,400);
    assert.equal((await fetch(base+`/api/cases/${id}?filed=2030-01-01`)).status,400);
    const feedback=await (await post(base,'/api/feedback',{memoryId:detail.findingMemoryIds[0],kind:'helpful'})).json();assert(Math.abs(feedback.confidence-0.9)<1e-8);
    assert.equal((await post(base,`/api/cases/${id}/runs`)).status,503);
    assert.equal((await post(base,`/api/cases/${id}/runs`,{filed:'1900-01-01'})).status,400);
    assert.equal((await fetch(base+'/api/cases/9999999_2015-12-31')).status,404);
    assert.equal((await fetch(base+`/api/cases/${id}/evidence/E99999`)).status,404);
    assert.equal((await post(base,'/api/feedback',{memoryId:'missing',kind:'helpful'})).status,400);
  }finally{await server.close();}
});

test('a live run traces the SQL behind every evidence item, then H-MEM recall, World Model ingest and H-MEM remember',{timeout:20000},async()=>{
  const run=(await recordedCases()).find(r=>r.cik===1336917&&r.fy_end==='2015-12-31')!,sample=run.samples[0],events:Record<string,any>[]=[];
  const runtime=await AppRuntime.create({source:new CsvSource(),sampleMode:false,persist:false,trace:e=>events.push(e),ask:async(system)=>
    structuredClone(system===INVESTIGATOR?sample.investigator:system===RED_TEAM?sample.red_team:sample.judge) as unknown as Record<string,unknown>});
  const id='1336917_2015-12-31',job=runtime.startRun(id);
  for(let i=0;i<200&&job.status==='running';i++)await delay(10);
  assert.equal(job.status,'completed');
  const steps=events.map(e=>`${e.agent_name}:${e.action}`),queries=events.filter(e=>e.action==='query');
  assert.deepEqual(steps.filter(s=>!s.endsWith(':query')),['h_mem:recall','world_model:ingest','h_mem:remember']);
  assert(steps.indexOf('h_mem:recall')<steps.indexOf(steps.find(s=>s.endsWith(':query'))!));
  assert(queries.every(q=>q.agent_name==='csv_source'&&q.sql.includes('SELECT')&&q.rows_used>0));
  assert.deepEqual(new Set(queries.flatMap(q=>q.evidence_ids)),new Set(run.evidence.map(e=>e.id)));
  assert(events.every(e=>e.company===run.company&&e.fy_end==='2015-12-31'&&e.job===job.id));
  assert(events.at(-1)!.stored>0&&events.find(e=>e.agent_name==='world_model')!.processed>0);
});

test('live API completes three samples over replayable SSE, serializes jobs, and surfaces provider failure',{timeout:20000},async()=>{
  const run=(await recordedCases()).find(r=>r.cik===1336917&&r.fy_end==='2015-12-31')!,sample=run.samples[0];
  let fail=false,calls=0;
  const runtime=await AppRuntime.create({source:new CsvSource(),sampleMode:false,persist:false,ask:async(system)=>{
    calls++;await delay(10);if(fail)throw new Error('NIM HTTP 503 after 3 attempts');
    return structuredClone(system===INVESTIGATOR?sample.investigator:system===RED_TEAM?sample.red_team:sample.judge) as unknown as Record<string,unknown>;
  }}),server=await serve(runtime),{base}=server,id='1336917_2015-12-31';
  try{
    const response=await post(base,`/api/cases/${id}/runs`);assert.equal(response.status,202);const job=await response.json();
    const running=await (await fetch(base+`/api/cases/${id}`)).json();assert.equal(running.liveJob.id,job.id);assert.equal(running.resultMode,'recorded');
    assert.equal((await post(base,`/api/cases/${id}/runs`)).status,409);
    const sse=await fetch(base+job.eventsUrl);assert(sse.headers.get('content-type')?.includes('text/event-stream'));
    const text=await sse.text(),events=text.split('\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
    assert.equal(events[0].type,'started');assert.equal(events.at(-1).type,'completed');
    assert.equal(events.filter(e=>e.type==='progress'&&e.status==='completed').length,9);assert.equal(calls,9);
    const replay=await (await fetch(base+job.eventsUrl,{headers:{'Last-Event-ID':'19'}})).text();assert(replay.includes('"type":"completed"'));assert(!replay.includes('"type":"started"'));
    const detail=await (await fetch(base+`/api/cases/${id}`)).json();assert.equal(detail.run.samples.length,3);assert.deepEqual(detail.run.agreement.investigator,{[sample.investigator.verdict]:3});assert.equal(detail.resultMode,'live');assert.equal(detail.liveJob,null);
    const reference=runtime.list().cases.find(c=>c.id===id)!;assert.deepEqual(reference.agreement,run.agreement);assert.equal(reference.liveAvailable,true);
    fail=true;const failed=await (await post(base,`/api/cases/${id}/runs`)).json();
    const failure=await (await fetch(base+failed.eventsUrl)).text();assert(failure.includes('"type":"failed"'));assert(failure.includes('NIM HTTP 503'));
  }finally{await server.close();}
});
