import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './paths.ts';
import { addedCompanies, caseId, cohortSplit, filingIdentity, recordedCases, type FilingIdentity } from './cases.ts';
import { evidencePack, type EvidencePack } from './agent/evidence.ts';
import { assertRunGrounded, runCase, saveRun } from './agent/run.ts';
import type { CaseRun } from './agent/types.ts';
import { provider, type Ask } from './agent/nim.ts';
import type { FactsSource } from './data/source.ts';
import type { Row } from './data/csv.ts';
import { configuredSource } from './data/index.ts';
import { CaseMemory } from './memory/cases.ts';
import { WorldEvidenceStore } from './memory/world.ts';
import { cohortQuery, query } from './data/queries.ts';

export class HttpError extends Error { constructor(readonly status:number,message:string){super(message);} }
// A case is a recorded cohort company-year or one added at runtime; added ones have no recording and run live.
interface Entry { cik:number; company:string; fyEnd:string; added:boolean; run?:CaseRun; recorded?:CaseRun; pack:EvidencePack; filing:FilingIdentity; score:string; flagged:boolean|null;industry:string }
export interface RunEvent { type:'started'|'progress'|'completed'|'failed'; [key:string]:unknown }
export interface Job { id:string; caseId:string; status:'running'|'completed'|'failed'; events:{seq:number;data:RunEvent}[]; listeners:Set<(event:{seq:number;data:RunEvent})=>void>; controller:AbortController }
export interface RuntimeOptions { source?:FactsSource; sampleMode?:boolean; stateDir?:string; persist?:boolean; ask?:Ask }
const execFileP=promisify(execFile);

// Evidence, filing identity, Beneish screen and industry for one company-year, all from the data source.
async function entryFor(source:FactsSource,cik:number,fyEnd:string,industries:Row[],added:boolean,recorded?:CaseRun):Promise<Entry>{
  const pack=await evidencePack(source,cik,fyEnd),company=recorded?.company??pack.company;
  const filing=await filingIdentity(source,cik,fyEnd,company);
  const b=(await source.execute(query('beneish',cik,fyEnd))).rows[0];
  return {cik,company,fyEnd,added,run:recorded,recorded,pack,filing,score:b?.m_score??'',flagged:b?.flagged?b.flagged==='True':null,industry:industries.find(r=>Number(r.cik)===cik&&r.fy_end===fyEnd)?.industry??''};
}

// Single-user research runtime. The World Model is rebuilt in memory; saved runs, added companies and H-MEM persist.
export class AppRuntime {
  readonly sampleMode:boolean;
  readonly dataMode:'csv'|'zetaris';
  readonly world=new WorldEvidenceStore();
  readonly memory:CaseMemory;
  readonly jobs=new Map<string,Job>();
  private activeJob?:Job;
  private adding:Promise<unknown>=Promise.resolve();
  private entries=new Map<string,Entry>();
  private roles=new Map<number,'fraud'|'peer'>();
  private constructor(private options:RuntimeOptions,private source:FactsSource, entries:Entry[],roles:Map<number,'fraud'|'peer'>){
    this.sampleMode=options.sampleMode??process.env.SAMPLE_MODE!=='false';
    this.dataMode=entries[0].pack.origins.E1.queries[0].mode;
    this.roles=roles;
    for(const entry of entries)this.entries.set(entry.filing.caseId,entry);
    this.memory=new CaseMemory(entries.map(e=>e.filing),{persistDir:options.persist===false?undefined:join(this.stateDir,'hmem')});
  }
  private get stateDir(){return this.options.stateDir??join(ROOT,'app/.state');}

  static async create(options:RuntimeOptions={}):Promise<AppRuntime>{
    const source=options.source??configuredSource(),runs=await recordedCases();
    const recordedIds=new Set(runs.map(r=>caseId(r.cik,r.fy_end)));
    const added=options.persist===false?[]:(await addedCompanies(join(options.stateDir??join(ROOT,'app/.state'),'companies'))).filter(a=>!recordedIds.has(a.id));
    for(const a of added)await source.addCompany?.(a.dir);
    const industries=(await source.execute(cohortQuery())).rows;
    // Cases load concurrently so network round trips to the bridge overlap; the bridge serializes the SQL itself.
    const entries:Entry[]=await Promise.all(runs.map(async run=>{
      const entry=await entryFor(source,run.cik,run.fy_end,industries,false,run);
      if(JSON.stringify(entry.pack.evidence.map(e=>[e.id,e.kind,e.text,e.source]))!==JSON.stringify(run.evidence.map(e=>[e.id,e.kind,e.text,e.source])))throw new Error(`Source evidence differs from recording ${caseId(run.cik,run.fy_end)}`);
      return entry;
    }));
    for(const a of added){
      try{entries.push(await entryFor(source,a.cik,a.fyEnd,industries,true));}
      catch(error){console.error(`Skipping added company ${a.id}:`,error instanceof Error?error.message:error);}
    }
    const cohort=JSON.parse(await readFile(join(ROOT,'data/cohort.json'),'utf8'));
    const roles=new Map<number,'fraud'|'peer'>(cohort.companies.map((c:any)=>[c.cik,c.role]));
    const runtime=new AppRuntime(options,source,entries,roles);
    for(const entry of entries)if(entry.run){await runtime.world.ingest(entry.run,entry.pack);runtime.memory.remember(entry.run);}
    if(!runtime.sampleMode && options.persist!==false){
      const dir=join(runtime.stateDir,'runs');await mkdir(dir,{recursive:true});
      for(const file of (await readdir(dir)).filter(f=>/^\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f))){
        const id=file.slice(0,-5),entry=runtime.entries.get(id);if(!entry)continue;
        const run:CaseRun=JSON.parse(await readFile(join(dir,file),'utf8'));assertRunGrounded(run);
        if(caseId(run.cik,run.fy_end)!==id || run.samples.length!==3)throw new Error(`Invalid saved case ${id}`);
        await runtime.world.ingest(run,entry.pack);runtime.memory.remember(run);entry.run=run;
      }
    }
    return runtime;
  }

  get liveEnabled(){return !this.sampleMode && Boolean(this.options.ask||process.env.METERLESS_RUNTIME_TOKEN&&process.env.METERLESS_BASE_URL||process.env.NVIDIA_API_KEY);}
  get liveUnavailableReason(){return this.sampleMode?'Start the server with SAMPLE_MODE=false and Meterless Nightshift (METERLESS_BASE_URL, METERLESS_RUNTIME_TOKEN) to enable live runs.':this.liveEnabled?'':'Live mode requires Meterless Nightshift (METERLESS_BASE_URL + METERLESS_RUNTIME_TOKEN) or NVIDIA_API_KEY on the server.';}
  private mustEntry(id:string){const entry=this.entries.get(id);if(!entry)throw new HttpError(404,'Case not found. Return to the cohort to choose a recorded case.');return entry;}

  list(reveal=false){
    const cases=[...this.entries.entries()].map(([id,e])=>{const shown=e.recorded??e.run;return {id,cik:e.cik,company:e.company,fyEnd:e.fyEnd,split:e.added?'added':cohortSplit(id),filed:e.filing.filed,
      beneish:{score:e.score,flagged:e.flagged},industry:e.industry,industryLabel:this.dataMode==='csv'?'Zetaris only':e.industry?'':'No industry match',agreement:shown?.agreement??null,samples:shown?.samples.length??0,resultMode:e.recorded?'recorded':e.run?'live':'none',liveAvailable:Boolean(e.recorded&&e.run!==e.recorded),
      topQuestion:shown?.samples[0]?.investigator.questions_for_management[0]??'',
      ...(reveal?{role:this.roles.get(e.cik)}:{})};});
    const recorded=[...this.entries.values()].flatMap(e=>e.recorded?[e.recorded]:[]);
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
      const rows=e.pack.origins[it.id].rows,c=rows.find(r=>r.fy_end===e.fyEnd)!,o=rows.find(r=>r.fy_end===e.pack.prior)!;
      return {evidenceId:it.id,quarter:Number(it.text.match(/^Fiscal Q(\d)/)![1]),period:c.q_end,revenueGrowth:100*(Number(c.revenue)/Number(o.revenue)-1),receivablesGrowth:100*(Number(c.receivables)/Number(o.receivables)-1),dsoPrior:91*Number(o.receivables)/Number(o.revenue),dsoCurrent:91*Number(c.receivables)/Number(c.revenue)};
    });
    const liveJob=this.activeJob?.status==='running'?{id:this.activeJob.id,caseId:this.activeJob.caseId,eventsUrl:`/api/runs/${this.activeJob.id}/events`}:null;
    return {id,cik:e.cik,company:e.company,fyEnd:e.fyEnd,added:e.added,evidenceCount:e.pack.evidence.length,run:e.run??null,filing:e.filing,split:e.added?'added':cohortSplit(id),mode:this.sampleMode?'sample':'live',resultMode:!e.run?'none':e.run===e.recorded?'recorded':'live',liveJob,dataMode:this.dataMode,liveEnabled:this.liveEnabled,
      liveUnavailableReason:this.liveUnavailableReason,liveVia:this.options.ask?'test':provider().name,findingMemoryIds:this.memory.findingMemoryIds(id),memory:this.memory.recall(id),quarterComparison};
  }

  provenance(id:string,eid:string,revision?:string){
    const e=this.mustEntry(id);if(!/^E[1-9]\d*$/.test(eid))throw new HttpError(400,'Invalid evidence id');
    if(!e.run){
      // Before the first run the World Model has no revision yet: show the evidence pack's own SQL, rows and filing.
      const evidence=e.pack.evidence.find(it=>it.id===eid);if(!evidence)throw new HttpError(404,'Evidence not found in this case.');
      return {evidence,origins:e.pack.origins[eid],filings:[{attrs:{url:e.filing.url,accn:e.filing.accn,filed:e.filing.filed,form:'10-K',company:e.company}}],findings:[],rulings:[],relationships:[],audit:[]};
    }
    try{return this.world.provenance(id,eid,revision);}catch{throw new HttpError(404,'Evidence or revision not found in the World Model.');}
  }
  recall(id:string,q?:string){this.mustEntry(id);return this.memory.recall(id,q);}
  feedback(memoryId:string,kind:'helpful'|'not_helpful'|'wrong'){
    try{this.memory.feedback(memoryId,kind);}catch{throw new HttpError(400,'Unknown finding memory or invalid feedback.');}
    return {ok:true,confidence:this.memory.hmem.store.get(memoryId)!.confidence};
  }

  // Fetch a company-year from SEC EDGAR (data/add_company.py), load it into the data source and add the case.
  // One add at a time; returns the case id, also when the company-year is already present.
  addCompany(company:string,year:number):Promise<{id:string;existing:boolean}>{
    if(!/^(\d{1,10}|[A-Za-z][A-Za-z.\-]{0,9})$/.test(company))throw new HttpError(400,'Enter a ticker (e.g. NKE) or a numeric CIK.');
    const max=new Date().getUTCFullYear();
    if(!Number.isInteger(year)||year<2010||year>max)throw new HttpError(400,`Enter a fiscal year between 2010 and ${max}.`);
    if(!this.source.addCompany)throw new HttpError(501,'This data source cannot add companies.');
    const next=this.adding.then(async()=>{
      const out=join(this.stateDir,'companies');await mkdir(out,{recursive:true});
      let meta:{id:string;cik:number;fy_end:string;dir:string};
      try{
        const {stdout}=await execFileP(process.env.PYTHON??'python3',['-I',join(ROOT,'data/add_company.py'),company,String(year),'--out',out],{timeout:180000});
        meta=JSON.parse(stdout.trim().split('\n').pop()!);
      }catch(error:any){throw new HttpError(422,String(error?.stderr??'').trim().split('\n').pop()||'Could not fetch this company-year from SEC EDGAR.');}
      if(this.entries.has(meta.id)){if(!this.entries.get(meta.id)!.added)await rm(meta.dir,{recursive:true,force:true});return {id:meta.id,existing:true};}
      try{
        await this.source.addCompany!(meta.dir);
        const industries=(await this.source.execute(cohortQuery())).rows;
        const entry=await entryFor(this.source,meta.cik,meta.fy_end,industries,true);
        this.memory.addFiling(entry.filing);this.entries.set(meta.id,entry);
      }catch(error){
        await rm(meta.dir,{recursive:true,force:true});
        throw new HttpError(422,`SEC data for this company-year is incomplete: ${error instanceof Error?error.message:'unknown error'}`);
      }
      return {id:meta.id,existing:false};
    });
    this.adding=next.catch(()=>undefined);
    return next;
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
        const result=await runCase(entry.cik,entry.fyEnd,entry.pack,{samples:3,ask:this.options.ask,signal:job.controller.signal,progress:p=>this.emit(job,{type:'progress',...p})});
        assertRunGrounded(result);
        if(this.options.persist!==false)await saveRun(join(this.stateDir,'runs',`${id}.json`),result);
        await this.world.ingest(result,entry.pack);this.memory.remember(result);entry.run=result;
        job.status='completed';this.emit(job,{type:'completed'});
      }catch(error){job.status='failed';this.emit(job,{type:'failed',error:error instanceof Error?error.message:'Live run failed'});}
    })();
    return job;
  }
  private emit(job:Job,data:RunEvent){const event={seq:job.events.length+1,data};job.events.push(event);for(const fn of job.listeners)fn(event);if(!this.sampleMode)console.log(JSON.stringify({job:job.id,...data}));}
  shutdown(){for(const job of this.jobs.values())if(job.status==='running')job.controller.abort();}
}
