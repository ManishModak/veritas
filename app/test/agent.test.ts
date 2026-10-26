import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, RUNS } from '../src/paths.ts';
import * as prompts from '../src/agent/prompts.ts';
import { MODEL, nimClient, parseAnswer } from '../src/agent/nim.ts';
import { agreement, evidenceHead, grounding, runCase, runOnce, validateStage } from '../src/agent/run.ts';
import { CsvSource } from '../src/data/source.ts';
import { evidencePack } from '../src/agent/evidence.ts';
import type { CaseRun, Progress } from '../src/agent/types.ts';

const recorded: CaseRun = JSON.parse(await readFile(resolve(RUNS,'1336917_2015-12-31.json'),'utf8'));
const sample = recorded.samples[0];

test('all four frozen prompt strings equal the Python triple-quoted constants character for character', async () => {
  const python = await readFile(resolve(ROOT,'agent/spike.py'),'utf8');
  const rules = python.match(/\nEVIDENCE_RULES = """([\s\S]*?)"""/)![1];
  assert.equal(prompts.EVIDENCE_RULES,rules);
  for (const key of ['INVESTIGATOR','RED_TEAM','JUDGE'] as const) {
    const parts = python.match(new RegExp(`\\n${key} = """([\\s\\S]*?)""" \\+ EVIDENCE_RULES \\+ """([\\s\\S]*?)"""`));
    assert(parts, `Reference ${key} assignment must retain its frozen structure`);
    assert.equal(prompts[key],parts[1]+rules+parts[2]);
  }
});

test('answer regex accepts investigator, defender and judge; rejects malformed and reasoning-only answers', () => {
  for (const stage of [sample.investigator,sample.red_team,sample.judge]) assert.deepEqual(parseAnswer(`Answer:\n\`\`\`json\n${JSON.stringify(stage)}\n\`\`\``),stage);
  assert.throws(()=>parseAnswer('{"thought":"reasoning"}'),/missing/);
  assert.throws(()=>parseAnswer('{"verdict": broken}'),/invalid JSON/);
});

test('NIM sends frozen call settings, retries transient errors and reads content instead of reasoning', async () => {
  const calls: any[] = [], retries: number[] = [];
  const mock = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    if(calls.length < 3) return new Response('temporary',{status:calls.length === 1 ? 503 : 429});
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(sample.investigator),reasoning_content:'{"verdict":"DO NOT PARSE"}'}}]});
  }) as typeof fetch;
  const result = await nimClient({apiKey:'test-secret',fetch:mock,backoffMs:1,onRetry:n=>retries.push(n)})('system','user');
  assert.deepEqual(result,sample.investigator); assert.deepEqual(retries,[1,2]);
  assert.deepEqual(calls[0],{model:MODEL,temperature:0.3,max_tokens:16000,messages:[{role:'system',content:'system'},{role:'user',content:'user'}]});
});

test('NIM bounds timeouts and redacts provider bodies and network errors; permanent failures never retry', async () => {
  let calls=0;
  const unauthorized = (async()=>{calls++;return new Response('test-secret provider body',{status:401});}) as typeof fetch;
  await assert.rejects(nimClient({apiKey:'test-secret',fetch:unauthorized})('s','u'),e=>e instanceof Error && e.message === 'NIM HTTP 401' && !e.message.includes('test-secret'));
  assert.equal(calls,1);
  const hanging = (async (_url: any, init: any) => await new Promise<Response>((_,reject)=>{
    const keepAlive=setTimeout(()=>reject(new Error('unexpected wait')),1000);
    init.signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(new Error('test-secret'));},{once:true});
  })) as typeof fetch;
  await assert.rejects(nimClient({apiKey:'test-secret',fetch:hanging,timeoutMs:5,attempts:2,backoffMs:1})('s','u'), /timeout after 2 attempts/);
  const truncated = (async()=>Response.json({choices:[{finish_reason:'length',message:{content:JSON.stringify(sample.investigator)}}]})) as typeof fetch;
  await assert.rejects(nimClient({apiKey:'test-secret',fetch:truncated})('s','u'),/truncated/);
});

test('grounding counts unknown ids and missing evidence; malformed stages cannot pass vacuously', () => {
  assert.deepEqual(grounding({findings:[{evidence:['E1','E999']},{evidence:[]}]},'findings',new Set(['E1'])),{citations:2,unknown_ids:['E999'],uncited:1});
  assert.throws(()=>validateStage('investigator',{raw:'no answer'}),/Invalid investigator schema/);
  assert.throws(()=>validateStage('judge',{final_verdict:'anything',rulings:[]}),/Invalid judge schema/);
  validateStage('investigator',{...sample.investigator,verdict:'explanation partially fits the numbers'});
});

test('grounding and agreement reproduce every recorded sample, including off-schema verdict text',async()=>{
  let stages=0;
  for(const file of (await readdir(RUNS)).filter(f=>f.endsWith('.json'))){
    const run: CaseRun=JSON.parse(await readFile(resolve(RUNS,file),'utf8'));
    const ids=new Set(run.evidence.map(e=>e.id));
    assert.deepEqual(agreement(run.samples),run.agreement);
    for(const s of run.samples) for(const [stage,key] of [['investigator','findings'],['red_team','rebuttals'],['judge','rulings']] as const){
      validateStage(stage,s[stage]);
      assert.deepEqual(grounding(s[stage],key,ids),s.grounding[stage]);stages++;
    }
  }
  assert.equal(stages,99);
});

test('runCase is independent per sample, preserves the recorded JSON shape, stage order and arbitrary verdict labels', async () => {
  const pack=await evidencePack(new CsvSource(),1336917,'2015-12-31');
  const heads: string[]=[], systems: string[]=[], progress: Progress[]=[];
  const result=await runCase(1336917,'2015-12-31',pack,{samples:3,progress:p=>progress.push(p),ask:async (system,user)=>{
    systems.push(system); if(system === prompts.INVESTIGATOR) heads.push(user);
    const data = system === prompts.INVESTIGATOR ? {...sample.investigator,verdict:'unknown label'} : system === prompts.RED_TEAM ? sample.red_team : sample.judge;
    return structuredClone(data) as unknown as Record<string,unknown>;
  }});
  assert.equal(heads.length,3); assert(heads.every(h=>h===evidenceHead(pack)));
  assert.deepEqual(systems,[prompts.INVESTIGATOR,prompts.RED_TEAM,prompts.JUDGE,prompts.INVESTIGATOR,prompts.RED_TEAM,prompts.JUDGE,prompts.INVESTIGATOR,prompts.RED_TEAM,prompts.JUDGE]);
  assert.deepEqual(Object.keys(result),Object.keys(recorded));
  assert.deepEqual(result.agreement.investigator,{'unknown label':3});
  assert.equal(progress.length,18);
  assert.deepEqual(agreement(recorded.samples),recorded.agreement);
  assert(result.samples.every(s=>Object.values(s.grounding).every(g=>g.unknown_ids.length===0 && g.uncited===0)));
});

test('out-of-range and duplicate finding indices fail before saving a result',async()=>{
  let call=0;
  await assert.rejects(runOnce('pack',new Set(['E1']),async()=>{
    call++;
    return (call===1 ? sample.investigator : call===2 ? {...sample.red_team,rebuttals:sample.red_team.rebuttals.map(r=>({...r,finding_index:999}))} : sample.judge) as unknown as Record<string,unknown>;
  }),/out-of-range/);
});
