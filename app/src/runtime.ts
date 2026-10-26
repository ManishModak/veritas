import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './paths.ts';
import { caseId, cohortSplit, filingCatalogue, recordedCases, type FilingIdentity } from './cases.ts';
import { evidencePack, type EvidencePack } from './agent/evidence.ts';
import { assertRunGrounded, runCase, saveRun } from './agent/run.ts';
import type { CaseRun } from './agent/types.ts';
import type { Ask } from './agent/nim.ts';
import type { FactsSource } from './data/source.ts';
import { configuredSource } from './data/index.ts';
import { CaseMemory } from './memory/cases.ts';
import { WorldEvidenceStore } from './memory/world.ts';
import { cohortQuery, query } from './data/queries.ts';

export class HttpError extends Error { constructor(readonly status:number,message:string){super(message);} }
interface Entry { run:CaseRun; recorded:CaseRun; pack:EvidencePack; filing:FilingIdentity; score:string; flagged:boolean|null;industry:string }
export interface RunEvent { type:'started'|'progress'|'completed'|'failed'; [key:string]:unknown }
export interface Job { id:string; caseId:string; status:'running'|'completed'|'failed'; events:{seq:number;data:RunEvent}[]; listeners:Set<(event:{seq:number;data:RunEvent})=>void>; controller:AbortController }
export interface RuntimeOptions { source?:FactsSource; sampleMode?:boolean; stateDir?:string; persist?:boolean; ask?:Ask }

// Single-user research runtime. The World Model is rebuilt in memory; saved runs and H-MEM persist.
export class AppRuntime {
  readonly sampleMode:boolean;
  readonly dataMode:'csv'|'zetaris';
  readonly world=new WorldEvidenceStore();
  readonly memory:CaseMemory;
  readonly jobs=new Map<string,Job>();
  private activeJob?:Job;
  private entries=new Map<string,Entry>();
  private roles=new Map<number,'fraud'|'peer'>();
  private constructor(private options:RuntimeOptions, entries:Entry[],roles:Map<number,'fraud'|'peer'>){
    this.sampleMode=options.sampleMode??process.env.SAMPLE_MODE!=='false';
    this.dataMode=entries[0].pack.origins.E1.queries[0].mode;
    this.roles=roles;
    for(const entry of entries)this.entries.set(entry.filing.caseId,entry);
    this.memory=new CaseMemory(entries.map(e=>e.filing),{persistDir:options.persist===false?undefined:join(options.stateDir??join(ROOT,'app/.state'),'hmem')});
  }

  static async create(options:RuntimeOptions={}):Promise<AppRuntime>{
    const source=options.source??configuredSource(),runs=await recordedCases(),filings=await filingCatalogue(source,runs);
    const industries=(await source.execute(cohortQuery())).rows;
    const entries:Entry[]=[];
    for(const [i,run] of runs.entries()){
      const pack=await evidencePack(source,run.cik,run.fy_end);
      if(JSON.stringify(pack.evidence.map(e=>[e.id,e.kind,e.text,e.source]))!==JSON.stringify(run.evidence.map(e=>[e.id,e.kind,e.text,e.source])))throw new Error(`Source evidence differs from recording ${caseId(run.cik,run.fy_end)}`);
      const b=(await source.execute(query('beneish',run.cik,run.fy_end))).rows[0];
      entries.push({run,recorded:run,pack,filing:filings[i],score:b.m_score,flagged:b.flagged?b.flagged==='True':null,industry:industries.find(r=>Number(r.cik)===run.cik&&r.fy_end===run.fy_end)?.industry??''});
    }
    const cohort=JSON.parse(await readFile(join(ROOT,'data/cohort.json'),'utf8'));
    const roles=new Map<number,'fraud'|'peer'>(cohort.companies.map((c:any)=>[c.cik,c.role]));
    const runtime=new AppRuntime(options,entries,roles);
    for(const entry of entries){await runtime.world.ingest(entry.run,entry.pack);runtime.memory.remember(entry.run);}
    if(!runtime.sampleMode && options.persist!==false){
      const dir=join(options.stateDir??join(ROOT,'app/.state'),'runs');await mkdir(dir,{recursive:true});
      for(const file of (await readdir(dir)).filter(f=>/^\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f))){
        const id=file.slice(0,-5),entry=runtime.entries.get(id);if(!entry)continue;
        const run:CaseRun=JSON.parse(await readFile(join(dir,file),'utf8'));assertRunGrounded(run);
        if(caseId(run.cik,run.fy_end)!==id || run.samples.length!==3)throw new Error(`Invalid saved case ${id}`);
        await runtime.world.ingest(run,entry.pack);runtime.memory.remember(run);entry.run=run;
      }
    }
    return runtime;
  }

  get liveEnabled(){return !this.sampleMode && Boolean(this.options.ask||process.env.NVIDIA_API_KEY);}
  get liveUnavailableReason(){return this.sampleMode?'Start the server with SAMPLE_MODE=false and NVIDIA_API_KEY to enable live runs.':this.liveEnabled?'':'Live mode requires NVIDIA_API_KEY on the server.';}
  private mustEntry(id:string){const entry=this.entries.get(id);if(!entry)throw new HttpError(404,'Case not found. Return to the cohort to choose a recorded case.');return entry;}

  list(reveal=false){
    const cases=[...this.entries.entries()].map(([id,e])=>({id,cik:e.run.cik,company:e.run.company,fyEnd:e.run.fy_end,split:cohortSplit(id),filed:e.filing.filed,
      beneish:{score:e.score,flagged:e.flagged},industry:e.industry,industryLabel:this.dataMode==='csv'?'Zetaris only':e.industry?'':'No industry match',agreement:e.recorded.agreement,samples:e.recorded.samples.length,resultMode:'recorded',liveAvailable:e.run!==e.recorded,
      topQuestion:e.recorded.samples.flatMap(s=>s.investigator.questions_for_management).find(q=>/pull.forward|Q1 2016/i.test(q))??e.recorded.samples[0].investigator.questions_for_management[0]??'',
      ...(reveal?{role:this.roles.get(e.run.cik)}:{})}));
    const recorded=[...this.entries.values()].map(e=>e.recorded);
    const blind=recorded.filter(r=>cohortSplit(caseId(r.cik,r.fy_end))==='blind');
    const majority=(r:CaseRun)=>(r.agreement.investigator['explanation does not fit the numbers']??0)>r.samples.length/2;
    return {mode:this.sampleMode?'sample':'live',dataMode:this.dataMode,liveEnabled:this.liveEnabled,cases,results:{
      calls:recorded.reduce((n,r)=>n+r.samples.length*3,0),unknownIds:recorded.reduce((n,r)=>n+r.samples.reduce((a,s)=>a+Object.values(s.grounding).reduce((b,g)=>b+g.unknown_ids.length,0),0),0),
      blindFraud:{majorityDoesNotFit:blind.filter(r=>this.roles.get(r.cik)==='fraud'&&majority(r)).length,total:blind.filter(r=>this.roles.get(r.cik)==='fraud').length},
      blindPeers:{majorityDoesNotFit:blind.filter(r=>this.roles.get(r.cik)==='peer'&&majority(r)).length,total:blind.filter(r=>this.roles.get(r.cik)==='peer').length},
    }};
  }

  detail(id:string){
    const e=this.mustEntry(id);
    const quarterComparison=e.pack.evidence.filter(it=>it.kind==='signal'&&it.text.startsWith('Fiscal Q')).map(it=>{
      const rows=e.pack.origins[it.id].rows,c=rows.find(r=>r.fy_end===e.run.fy_end)!,o=rows.find(r=>r.fy_end===e.pack.prior)!;
      return {evidenceId:it.id,quarter:Number(it.text.match(/^Fiscal Q(\d)/)![1]),period:c.q_end,revenueGrowth:100*(Number(c.revenue)/Number(o.revenue)-1),receivablesGrowth:100*(Number(c.receivables)/Number(o.receivables)-1),dsoPrior:91*Number(o.receivables)/Number(o.revenue),dsoCurrent:91*Number(c.receivables)/Number(c.revenue)};
    });
    const liveJob=this.activeJob?.status==='running'?{id:this.activeJob.id,caseId:this.activeJob.caseId,eventsUrl:`/api/runs/${this.activeJob.id}/events`}:null;
    return {id,run:e.run,filing:e.filing,split:cohortSplit(id),mode:this.sampleMode?'sample':'live',resultMode:e.run===e.recorded?'recorded':'live',liveJob,dataMode:this.dataMode,liveEnabled:this.liveEnabled,
      liveUnavailableReason:this.liveUnavailableReason,findingMemoryIds:this.memory.findingMemoryIds(id),memory:this.memory.recall(id),quarterComparison};
  }

  provenance(id:string,eid:string,revision?:string){
    this.mustEntry(id);if(!/^E[1-9]\d*$/.test(eid))throw new HttpError(400,'Invalid evidence id');
    try{return this.world.provenance(id,eid,revision);}catch{throw new HttpError(404,'Evidence or revision not found in the World Model.');}
  }
  recall(id:string,q?:string){this.mustEntry(id);return this.memory.recall(id,q);}
  feedback(memoryId:string,kind:'helpful'|'not_helpful'|'wrong'){
    try{this.memory.feedback(memoryId,kind);}catch{throw new HttpError(400,'Unknown finding memory or invalid feedback.');}
    return {ok:true,confidence:this.memory.hmem.store.get(memoryId)!.confidence};
  }

  startRun(id:string):Job{
    const entry=this.mustEntry(id);
    if(!this.liveEnabled)throw new HttpError(503,this.liveUnavailableReason);
    if(this.activeJob?.status==='running')throw new HttpError(409,'A live case is already running. Wait for it to finish.');
    for(const [key,old] of this.jobs)if(this.jobs.size>=20&&old.status!=='running')this.jobs.delete(key);
    const job:Job={id:randomUUID(),caseId:id,status:'running',events:[],listeners:new Set(),controller:new AbortController()};
    this.jobs.set(job.id,job);this.activeJob=job;this.emit(job,{type:'started',total:3});
    void (async()=>{
      try{
        this.memory.recall(id);
        const result=await runCase(entry.run.cik,entry.run.fy_end,entry.pack,{samples:3,ask:this.options.ask,signal:job.controller.signal,progress:p=>this.emit(job,{type:'progress',...p})});
        assertRunGrounded(result);
        if(this.options.persist!==false)await saveRun(join(this.options.stateDir??join(ROOT,'app/.state'),'runs',`${id}.json`),result);
        await this.world.ingest(result,entry.pack);this.memory.remember(result);entry.run=result;
        job.status='completed';this.emit(job,{type:'completed'});
      }catch(error){job.status='failed';this.emit(job,{type:'failed',error:error instanceof Error?error.message:'Live run failed'});}
    })();
    return job;
  }
  private emit(job:Job,data:RunEvent){const event={seq:job.events.length+1,data};job.events.push(event);for(const fn of job.listeners)fn(event);if(!this.sampleMode)console.log(JSON.stringify({job:job.id,...data}));}
  shutdown(){for(const job of this.jobs.values())if(job.status==='running')job.controller.abort();}
}
