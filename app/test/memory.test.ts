import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CaseMemory } from '../src/memory/cases.ts';
import { filingCatalogue, recordedCases, type FilingIdentity } from '../src/cases.ts';
import { CsvSource } from '../src/data/source.ts';
import { ROOT } from '../src/paths.ts';

const runs=await recordedCases(), filings=await filingCatalogue(new CsvSource(),runs);
const ua=filings.find(f=>f.caseId==='1336917_2015-12-31')!, later=filings.find(f=>f.caseId==='1065837_2019-12-31')!;
const laterRun=runs.find(r=>r.cik===later.cik && r.fy_end===later.fyEnd)!;
const clock=()=>Date.parse('2026-10-26T00:00:00Z');

test('UA FY2015 cannot recall a later filing, even after changing memory dates or re-ingesting',()=>{
  const memory=new CaseMemory(filings,{clock});
  memory.remember(laterRun);
  const raw=memory.hmem.store.all()[0];
  memory.hmem.store.update(raw.id,{timestamp:0,lastAccessed:0,provenance:{...raw.provenance,learnedAt:0}});
  memory.remember(laterRun);
  const result=memory.recall(ua.caseId,'receivables revenue cash flow');
  assert.deepEqual(result.memories,[]);assert.equal(result.context,'');assert.deepEqual(result.trace.scores,{});
  assert.equal(result.trace.eligible,0);assert(result.trace.excluded>0);
  assert.throws(()=>memory.recall('unknown','receivables'),/Unknown case/);
});

test('earlier filings can be recalled, trace cannot mention later memory ids, roles never enter memory and ingest is idempotent',()=>{
  const memory=new CaseMemory(filings,{clock});
  for(const run of runs) memory.remember(run);
  const count=memory.hmem.store.all().length;
  for(const run of runs) memory.remember(run);
  assert.equal(memory.hmem.store.all().length,count);
  const result=memory.recall(ua.caseId,'receivables revenue cash flow',20);
  assert(result.memories.length>0);
  assert(result.memories.every(m=>m.filed<ua.filed && m.caseId!==ua.caseId));
  const laterIds=memory.hmem.store.all().filter(m=>m.source.startsWith(`veritas:${later.caseId}:`)).map(m=>m.id);
  for(const id of laterIds) assert(!Object.hasOwn(result.trace.scores,id));
  for(const m of memory.hmem.store.all()) assert(!/"(?:role|enforcement)"\s*:/.test(m.content));
  const [id]=memory.findingMemoryIds(ua.caseId);
  const confidence=memory.hmem.store.get(id)!.confidence;
  memory.feedback(id,'helpful');assert(Math.abs(memory.hmem.store.get(id)!.confidence-confidence-0.05)<1e-10);
  memory.feedback(id,'not_helpful');assert(Math.abs(memory.hmem.store.get(id)!.confidence-confidence-0.02)<1e-10);
  assert(memory.hmem.ledger.all().some(e=>e.action==='feedback'));
});

test('as-of guard uses a copied trusted catalogue and rejects same-date filings',()=>{
  const mutable: FilingIdentity[]=structuredClone(filings);
  const memory=new CaseMemory(mutable,{clock});
  mutable.find(f=>f.caseId===later.caseId)!.filed='1900-01-01';
  memory.remember(laterRun);assert.equal(memory.recall(ua.caseId).memories.length,0);
  const same=filings.map(f=>f.caseId===later.caseId?{...f,filed:ua.filed}:f);
  const sameDate=new CaseMemory(same,{clock});sameDate.remember(laterRun);
  assert.equal(sameDate.recall(ua.caseId).memories.length,0);
});

test('finding feedback mapping survives persistent H-MEM reload',async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),'veritas-hmem-reload-'));
  const first=new CaseMemory(filings,{persistDir:dir,clock});
  const ids=first.remember(laterRun);first.feedback(ids[0],'helpful');
  const reloaded=new CaseMemory(filings,{persistDir:dir,clock});
  assert.deepEqual(reloaded.findingMemoryIds(later.caseId),ids);
  const confidence=reloaded.hmem.store.get(ids[0])!.confidence;
  reloaded.feedback(ids[0],'not_helpful');
  assert(Math.abs(reloaded.hmem.store.get(ids[0])!.confidence-confidence+0.03)<1e-10);
});

test('mutation proof: removing the real filing-date guard leaks a later case and the same assertion catches it',async()=>{
  const source=resolve(ROOT,'app/src/memory/cases.ts');
  let code=await readFile(source,'utf8');
  assert(code.includes('filing.filed < cutoff.filed'));
  code=code.replace('filing.filed < cutoff.filed','true').replace(/from '(\.[^']+)'/g,(_,p)=>`from '${pathToFileURL(resolve(dirname(source),p)).href}'`);
  const dir=await mkdtemp(resolve(tmpdir(),'veritas-asof-mutant-')), file=resolve(dir,'cases.ts');
  await writeFile(file,code);
  const {CaseMemory:Mutant}=await import(pathToFileURL(file).href);
  const mutant=new Mutant(filings,{clock});mutant.remember(laterRun);
  const leaked=mutant.recall(ua.caseId,'receivables revenue cash flow');
  assert(leaked.memories.some((m:any)=>m.caseId===later.caseId),'Mutation must actually expose a later filing');
  assert.throws(()=>assert(leaked.memories.every((m:any)=>m.filed<ua.filed)),assert.AssertionError);
});
