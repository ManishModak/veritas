import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HMEM, type FeedbackKind } from '../../vendor/hmem/src/index.ts';
import { caseId, type FilingIdentity } from '../cases.ts';
import type { CaseRun } from '../agent/types.ts';
import { assertRunGrounded } from '../agent/run.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const memoryCase = (source: string) => /^veritas:(\d+_\d{4}-\d{2}-\d{2}):/.exec(source)?.[1];

export function eligibleBefore(filing: FilingIdentity, cutoff: FilingIdentity): boolean {
  return filing.caseId !== cutoff.caseId && filing.filed < cutoff.filed;
}

// H-MEM stores analyst patterns; the immutable filing catalogue enforces chronology before ranking or reinjection.
export class CaseMemory {
  readonly hmem: HMEM;
  private catalogue = new Map<string,FilingIdentity>();
  private activeFindings = new Map<string,string[]>();
  private indexFile?: string;
  constructor(filings: FilingIdentity[], options: {persistDir?: string; clock?:()=>number} = {}) {
    for(const filing of filings) this.catalogue.set(filing.caseId,Object.freeze({...filing}));
    this.hmem=new HMEM({persistDir:options.persistDir,clock:options.clock,actor:'veritas-analyst'});
    if(options.persistDir){
      this.indexFile=join(options.persistDir,'finding-index.json');
      if(existsSync(this.indexFile)){
        const index=JSON.parse(readFileSync(this.indexFile,'utf8')) as [string,string[]][];
        for(const [id,ids] of index){
          this.mustFiling(id);
          if(!Array.isArray(ids) || !ids.every(mid=>memoryCase(this.hmem.store.get(mid)?.source??'')===id)) throw new Error('Invalid persisted finding index');
          this.activeFindings.set(id,ids);
        }
      }
    }
  }

  remember(run: CaseRun): string[] {
    assertRunGrounded(run);
    const id=caseId(run.cik,run.fy_end), filing=this.mustFiling(id);
    const ids: string[]=[];
    // Keep each sample's findings and the union of questions. Nothing here reads cohort ground truth.
    const questions=[...new Set(run.samples.flatMap(s=>s.investigator.questions_for_management))];
    for(const [sampleIndex,sample] of run.samples.entries()) for(const [findingIndex,f] of sample.investigator.findings.entries()){
      const content=`${filing.company}, FY ending ${filing.fyEnd}. Management says: ${f.management_says}\nNumbers show: ${f.numbers_show}\nFit in sample ${sampleIndex+1}: ${f.fit}. Evidence: ${f.evidence.join(', ')}.\nQuestions for management: ${questions.join(' ')}`;
      const source=`veritas:${id}:${hash(content)}`;
      let memory=this.hmem.store.all().find(m=>m.source===source);
      if(!memory) memory=this.hmem.add({content,source,type:'factual',layer:'long_term',confidence:0.85,tags:['project:finance','receivables','revenue','cash flow'],
        provenance:{origin:'model_response',learnedAt:this.hmem.clock(),label:`${filing.company} ${filing.fyEnd}`,refs:[filing.url,...f.evidence.map(e=>`${id}:${e}`)]},chatId:id});
      if(sampleIndex===0) ids[findingIndex]=memory.id;
    }
    this.activeFindings.set(id,ids);
    if(this.indexFile){
      const tmp=`${this.indexFile}.tmp`;
      writeFileSync(tmp,JSON.stringify([...this.activeFindings])+'\n');renameSync(tmp,this.indexFile);
    }
    return [...ids];
  }

  findingMemoryIds(id: string): string[] { this.mustFiling(id); return [...(this.activeFindings.get(id)??[])]; }

  recall(id: string, queryText='receivables revenue cash flow', topN=5) {
    const cutoff=this.mustFiling(id);
    const all=this.hmem.store.snapshotAll();
    const eligible=all.records.filter(m=>{
      const owner=memoryCase(m.source), filing=owner ? this.catalogue.get(owner) : undefined;
      return filing && eligibleBefore(filing,cutoff);
    });
    const eligibleIds=new Set(eligible.map(m=>m.id));
    // Ranking sees only eligible records; relationship metadata cannot refer forward either.
    const filtered=eligible.map(m=>({...m,relatedTo:m.relatedTo.filter(x=>eligibleIds.has(x)),derivedFrom:m.derivedFrom?.filter(x=>eligibleIds.has(x)),
      supersededBy:m.supersededBy && eligibleIds.has(m.supersededBy) ? m.supersededBy : undefined,supersedes:m.supersedes && eligibleIds.has(m.supersedes) ? m.supersedes : undefined}));
    const scoped=new HMEM({clock:this.hmem.clock,actor:'veritas-as-of'});
    scoped.store.restoreAll(filtered,all.seq);
    const result=scoped.query(queryText,{topN:Math.max(1,Math.min(topN,20)),threshold:0.15});
    const memories=result.memories.map(({memory,relevance})=>{
      const filing=this.mustFiling(memoryCase(memory.source)!);
      this.hmem.store.touch(memory.id);
      this.hmem.ledger.log(memory.id,'read','veritas-as-of',{details:{query:queryText,cutoff:cutoff.filed}});
      return {memoryId:memory.id,caseId:filing.caseId,company:filing.company,fyEnd:filing.fyEnd,filed:filing.filed,url:filing.url,content:memory.content,score:relevance,confidence:memory.confidence};
    });
    this.hmem.store.persist();
    return {memories,context:result.context,trace:{...result.trace,cutoff:cutoff.filed,rule:'10-K filed strictly before current case; current case excluded',eligible:eligible.length,excluded:all.records.length-eligible.length,threshold:0.15,embedder:'Meterless deterministic hash reference'}};
  }

  feedback(memoryId: string, kind: FeedbackKind): void {
    if(!['helpful','not_helpful','wrong'].includes(kind)) throw new Error('Invalid feedback kind');
    const memory=this.hmem.store.get(memoryId);
    if(!memory || !this.catalogue.has(memoryCase(memory.source)??'')) throw new Error('Unknown finding memory');
    this.hmem.feedback(memoryId,kind);
  }

  private mustFiling(id: string): FilingIdentity {
    const filing=this.catalogue.get(id);
    if(!filing) throw new Error('Unknown case filing');
    return filing;
  }
}
