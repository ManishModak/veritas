import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, RUNS } from '../src/paths.ts';
import * as prompts from '../src/agent/prompts.ts';
import { MODEL, nimClient, parseAnswer } from '../src/agent/nim.ts';
import { agreement, evidenceHead, grounding, runCase, runOnce, validateStage, saveRun } from '../src/agent/run.ts';
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
  assert.deepEqual(parseAnswer('```json\n{"summary":"braces {inside} and \\"quotes\\"", "verdict":"fits"}\n``` trailing {note}'),{summary:'braces {inside} and "quotes"',verdict:'fits'});
  assert.deepEqual(parseAnswer('{"overall":"x", "rebuttals":[]} commentary }'),{overall:'x',rebuttals:[]});
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

test('Nightshift is the primary provider: Meterless endpoint, token and headers; inline reasoning dropped; routed model reported', async () => {
  let url = '', init: any = null; const seen: any[] = [];
  const mock = (async (u: any, i: any) => { url = String(u); init = i;
    return Response.json({model:MODEL,meterless:{routed_model:MODEL,receipt_id:'rcpt_1'},choices:[{finish_reason:'stop',message:{content:`{"verdict":"DO NOT PARSE"}</think>${JSON.stringify(sample.investigator)}`}}]});
  }) as typeof fetch;
  const env = {METERLESS_BASE_URL:'http://127.0.0.1:8088/v1/',METERLESS_RUNTIME_TOKEN:'runtime-secret',NVIDIA_API_KEY:'unused'};
  const result = await nimClient({env,fetch:mock,onResponse:c=>seen.push(c)})('system','user');
  assert.deepEqual(result,sample.investigator);
  assert.equal(url,'http://127.0.0.1:8088/v1/chat/completions');
  assert.equal(init.headers.Authorization,'Bearer runtime-secret'); assert.equal(init.headers['meterless-app'],'veritas'); assert.equal(init.headers['meterless-scope'],'user');
  assert.equal(JSON.parse(init.body).model,MODEL);
  assert.equal(seen.length,1); assert.equal(seen[0].provider,'meterless-nightshift'); assert.equal(seen[0].model,MODEL); assert.equal(seen[0].receipt,'rcpt_1');
  assert.throws(()=>nimClient({env:{METERLESS_BASE_URL:'http://127.0.0.1:8088/v1'}}),/METERLESS_RUNTIME_TOKEN/);
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

test('malformed answer JSON retries within the same bounded attempt budget',async()=>{
  let calls=0;
  const mock=(async()=>Response.json({choices:[{message:{content:++calls===1?'{"verdict": broken}':JSON.stringify(sample.investigator)}}]})) as typeof fetch;
  assert.deepEqual(await nimClient({apiKey:'test-secret',fetch:mock,attempts:2,backoffMs:1})('s','u'),sample.investigator);
  assert.equal(calls,2);
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

test('runCase runs samples in parallel, preserves the recorded JSON shape, stage order and arbitrary verdict labels', async () => {
  const pack=await evidencePack(new CsvSource(),1336917,'2015-12-31');
  const heads: string[]=[], systems: string[]=[], progress: Progress[]=[], users: string[]=[];
  const result=await runCase(1336917,'2015-12-31',pack,{samples:3,progress:p=>progress.push(p),ask:async (system,user)=>{
    systems.push(system); users.push(user); if(system === prompts.INVESTIGATOR) heads.push(user);
    const data = system === prompts.INVESTIGATOR ? {...sample.investigator,verdict:'unknown label'} : system === prompts.RED_TEAM ? sample.red_team : sample.judge;
    return structuredClone(data) as unknown as Record<string,unknown>;
  }});
  assert.equal(heads.length,3); assert(heads.every(h=>h===evidenceHead(pack)));
  const inv={...sample.investigator,verdict:'unknown label'};
  for(let n=0;n<3;n++){
    assert.equal(users[n+3],`${evidenceHead(pack)}\n\nInvestigator findings:\n${JSON.stringify(inv)}`);
    assert.equal(users[n+6],`${evidenceHead(pack)}\n\nInvestigator findings:\n${JSON.stringify(inv)}\n\nDefender rebuttals:\n${JSON.stringify(sample.red_team)}`);
  }
  assert.deepEqual(systems,[prompts.INVESTIGATOR,prompts.INVESTIGATOR,prompts.INVESTIGATOR,prompts.RED_TEAM,prompts.RED_TEAM,prompts.RED_TEAM,prompts.JUDGE,prompts.JUDGE,prompts.JUDGE]);
  assert.deepEqual(Object.keys(result),Object.keys(recorded));
  assert.deepEqual(result.agreement.investigator,{'unknown label':3});
  assert.equal(progress.length,18);
  assert.deepEqual(agreement(recorded.samples),recorded.agreement);
  assert(result.samples.every(s=>Object.values(s.grounding).every(g=>g.unknown_ids.length===0 && g.uncited===0)));
});

test('parallel runCase executes 3 samples in about 600ms (< 1200ms) rather than 1800ms sequential', async () => {
  const pack = await evidencePack(new CsvSource(), 1336917, '2015-12-31');
  const started = Date.now();
  const result = await runCase(1336917, '2015-12-31', pack, {
    samples: 3,
    ask: async (system) => {
      await delay(200);
      const data = system === prompts.INVESTIGATOR ? sample.investigator : system === prompts.RED_TEAM ? sample.red_team : sample.judge;
      return structuredClone(data) as unknown as Record<string, unknown>;
    },
  });
  const elapsed = Date.now() - started;
  assert(elapsed >= 500 && elapsed < 1200, `Expected elapsed time around 600ms (< 1200ms), got ${elapsed}ms`);
  assert.equal(result.samples.length, 3);
  assert.deepEqual(result.agreement, { investigator: { [sample.investigator.verdict]: 3 }, judge: { [sample.judge.final_verdict]: 3 } });
});

test('results stay in sample order 1..N even when sample 3 finishes first', async () => {
  const pack = await evidencePack(new CsvSource(), 1336917, '2015-12-31');
  let invCount = 0;
  const result = await runCase(1336917, '2015-12-31', pack, {
    samples: 3,
    ask: async (system, user) => {
      let sampleId: number;
      if (system === prompts.INVESTIGATOR) {
        sampleId = ++invCount;
      } else {
        const match = user.match(/sample-(\d)/);
        sampleId = match ? Number(match[1]) : 1;
      }
      // Sample 3 is fastest (10ms/call), Sample 2 is medium (50ms/call), Sample 1 is slowest (120ms/call)
      const waitMs = sampleId === 3 ? 10 : sampleId === 2 ? 50 : 120;
      await delay(waitMs);
      const data = system === prompts.INVESTIGATOR
        ? { ...sample.investigator, verdict: `verdict-sample-${sampleId}`, summary: `sample-${sampleId}` }
        : system === prompts.RED_TEAM
        ? sample.red_team
        : { ...sample.judge, final_verdict: `judge-sample-${sampleId}` };
      return structuredClone(data) as unknown as Record<string, unknown>;
    },
  });
  assert.equal(result.samples.length, 3);
  assert.equal(result.samples[0].investigator.verdict, 'verdict-sample-1');
  assert.equal(result.samples[1].investigator.verdict, 'verdict-sample-2');
  assert.equal(result.samples[2].investigator.verdict, 'verdict-sample-3');
  assert.equal(result.samples[0].judge.final_verdict, 'judge-sample-1');
  assert.equal(result.samples[1].judge.final_verdict, 'judge-sample-2');
  assert.equal(result.samples[2].judge.final_verdict, 'judge-sample-3');
});

test('aborting cancels all in-flight samples and leaves no orphaned requests', async () => {
  const pack = await evidencePack(new CsvSource(), 1336917, '2015-12-31');
  const controller = new AbortController();
  let inFlight = 0;
  let maxConcurrent = 0;

  const runPromise = runCase(1336917, '2015-12-31', pack, {
    samples: 3,
    signal: controller.signal,
    ask: async (system, _user, signal) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        await delay(200, undefined, { signal });
        const data = system === prompts.INVESTIGATOR ? sample.investigator : system === prompts.RED_TEAM ? sample.red_team : sample.judge;
        return structuredClone(data) as unknown as Record<string, unknown>;
      } finally {
        inFlight--;
      }
    },
  });

  await delay(50);
  assert.equal(maxConcurrent, 3);
  assert.equal(inFlight, 3);

  controller.abort();

  await assert.rejects(runPromise);
  assert.equal(inFlight, 0, 'All in-flight requests must be aborted and cleaned up');
});

test('one failing sample fails the run and immediately aborts the other samples', async () => {
  const pack = await evidencePack(new CsvSource(), 1336917, '2015-12-31');
  let inFlight = 0;
  let sampleCallCount = 0;

  await assert.rejects(
    runCase(1336917, '2015-12-31', pack, {
      samples: 3,
      ask: async (system, _user, signal) => {
        inFlight++;
        const currentCall = ++sampleCallCount;
        try {
          if (currentCall === 2) {
            await delay(50, undefined, { signal });
            throw new Error('Sample 2 deliberate failure');
          }
          await delay(300, undefined, { signal });
          const data = system === prompts.INVESTIGATOR ? sample.investigator : system === prompts.RED_TEAM ? sample.red_team : sample.judge;
          return structuredClone(data) as unknown as Record<string, unknown>;
        } finally {
          inFlight--;
        }
      },
    }),
    /Sample 2 deliberate failure/
  );

  assert.equal(inFlight, 0, 'All other samples must be aborted with 0 remaining in-flight');
});

test('NIM rate limit 429 during parallel execution triggers retry with backoff and reports progress', async () => {
  let attempts429 = 0;
  const retriedProgress: Progress[] = [];
  const mockFetch = (async () => {
    if (++attempts429 <= 2) {
      return new Response('Rate limited', { status: 429 });
    }
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(sample.investigator) } }],
    });
  }) as typeof fetch;

  const ask = nimClient({
    apiKey: 'test-key',
    fetch: mockFetch,
    backoffMs: 1,
    onRetry: n => retriedProgress.push({ sample: 1, total: 3, stage: 'investigator', status: 'retry', attempt: n }),
  });

  const res = await ask('system', 'user');
  assert.deepEqual(res, sample.investigator);
  assert.equal(retriedProgress.length, 2);
  assert.equal(retriedProgress[0].status, 'retry');
});

test('out-of-range and duplicate finding indices fail',async()=>{
  let call=0;
  await assert.rejects(runOnce('pack',new Set(['E1']),async()=>{
    call++;
    return (call===1 ? sample.investigator : call===2 ? {...sample.red_team,rebuttals:sample.red_team.rebuttals.map(r=>({...r,finding_index:999}))} : sample.judge) as unknown as Record<string,unknown>;
  }),/out-of-range/);
  call=0;
  await assert.rejects(runOnce('pack',new Set(['E1']),async()=>{
    call++;
    return (call===1 ? sample.investigator : {...sample.red_team,rebuttals:sample.red_team.rebuttals.map(r=>({...r,finding_index:0}))}) as unknown as Record<string,unknown>;
  }),/exactly one/);
  call=0;
  await assert.rejects(runOnce('pack',new Set(['E1']),async()=>{
    call++;
    return (call===1 ? sample.investigator : call===2 ? sample.red_team : {...sample.judge,rulings:sample.judge.rulings.map(r=>({...r,finding_index:999}))}) as unknown as Record<string,unknown>;
  }),/out-of-range/);
});

test('saveRun refuses unknown or absent citations before creating a result file, even with forged grounding counts',async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),'veritas-grounding-'));
  for(const evidence of [['E99999'],[]]){
    const defective=structuredClone(recorded);
    defective.samples[0].investigator.findings[0].evidence=evidence;
    const file=resolve(dir,evidence.length?'unknown.json':'uncited.json');
    await assert.rejects(saveRun(file,defective),/Citation check failed/);
    await assert.rejects(access(file));
  }
  const defective=structuredClone(recorded), file=resolve(dir,'indices.json');
  defective.samples[0].judge.rulings[0].finding_index=999;
  await assert.rejects(saveRun(file,defective),/out-of-range/);
  await assert.rejects(access(file));
});
