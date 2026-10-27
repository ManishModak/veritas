import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './paths.ts';
import { AppRuntime, HttpError } from './runtime.ts';

async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
  if(!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'Use Content-Type: application/json');
  let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>8192)throw new HttpError(413,'Request body too large');}
  let value:unknown;try{value=JSON.parse(text||'{}');}catch{throw new HttpError(400,'Invalid JSON request');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Expected a JSON object');
  return value as Record<string,unknown>;
}
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
function only(params:URLSearchParams,allowed:string[]){if([...params.keys()].some(k=>!allowed.includes(k)))throw new HttpError(400,'Unsupported query parameter; filing dates are server-controlled.');}

// Serve the same files and API in sample and live mode; all writes require JSON requests.
export function appServer(runtime:AppRuntime){
  return createServer(async(req,res)=>{
    try{
      const url=new URL(req.url??'/','http://localhost'),parts=url.pathname.split('/').filter(Boolean);
      if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,mode:runtime.sampleMode?'sample':'live',dataMode:runtime.dataMode});
      if(req.method==='GET'&&url.pathname==='/api/cases'){only(url.searchParams,['reveal']);return json(res,200,runtime.list(url.searchParams.get('reveal')==='true'));}
      if(parts[0]==='api'&&parts[1]==='cases'&&parts[2]){
        const id=parts[2];if(!/^\d+_\d{4}-\d{2}-\d{2}$/.test(id))throw new HttpError(404,'Case not found. Return to the cohort to choose a recorded case.');
        if(req.method==='GET'&&parts.length===3){only(url.searchParams,[]);return json(res,200,runtime.detail(id));}
        if(req.method==='GET'&&parts[3]==='evidence'&&parts.length===5){only(url.searchParams,['revision']);return json(res,200,runtime.provenance(id,parts[4],url.searchParams.get('revision')??undefined));}
        if(req.method==='GET'&&parts[3]==='memory'&&parts.length===4){only(url.searchParams,['q']);const q=url.searchParams.get('q')??undefined;if(q&&q.length>1000)throw new HttpError(400,'Memory query is too long');return json(res,200,runtime.recall(id,q));}
        if(req.method==='POST'&&parts[3]==='runs'&&parts.length===4){only(url.searchParams,[]);const input=await body(req);if(Object.keys(input).length)throw new HttpError(400,'Runs use three independent samples; no case metadata overrides are accepted.');const job=runtime.startRun(id);return json(res,202,{id:job.id,eventsUrl:`/api/runs/${job.id}/events`});}
      }
      if(req.method==='POST'&&url.pathname==='/api/companies'){
        const input=await body(req);if(Object.keys(input).some(k=>!['company','year'].includes(k))||typeof input.company!=='string'||typeof input.year!=='number')throw new HttpError(400,'Expected company (ticker or CIK) and year');
        const added=await runtime.addCompany(input.company.trim(),input.year);return json(res,added.existing?200:201,added);
      }
      if(req.method==='POST'&&url.pathname==='/api/feedback'){
        const input=await body(req);if(Object.keys(input).some(k=>!['memoryId','kind'].includes(k))||typeof input.memoryId!=='string'||!['helpful','not_helpful','wrong'].includes(String(input.kind)))throw new HttpError(400,'Expected memoryId and feedback kind');
        return json(res,200,runtime.feedback(input.memoryId,input.kind as 'helpful'|'not_helpful'|'wrong'));
      }
      if(req.method==='GET'&&parts[0]==='api'&&parts[1]==='runs'&&parts[3]==='events'&&parts.length===4){
        const job=runtime.jobs.get(parts[2]);if(!job)throw new HttpError(404,'Run not found');
        const after=Number(req.headers['last-event-id']??0);if(!Number.isSafeInteger(after)||after<0)throw new HttpError(400,'Invalid event cursor');
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
        const write=(event:{seq:number;data:unknown})=>res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event.data)}\n\n`);
        for(const event of job.events)if(event.seq>after)write(event);
        if(job.status!=='running'){res.end();return;}
        const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);
        const listener=(event:{seq:number;data:unknown})=>{write(event);if(job.status!=='running')res.end();};job.listeners.add(listener);
        res.on('close',()=>{clearInterval(timer);job.listeners.delete(listener);});return;
      }
      const assets:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(req.method==='GET'&&assets[url.pathname]){const [file,type]=assets[url.pathname];const bytes=await readFile(join(ROOT,'app/ui',file));res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'X-Content-Type-Options':'nosniff'});res.end(bytes);return;}
      throw new HttpError(404,'Not found');
    }catch(error){
      if(res.headersSent){res.end();return;}
      if(error instanceof HttpError)return json(res,error.status,{error:error.message});
      console.error('Request failed:',error instanceof Error?error.message:'unknown error');json(res,500,{error:'Unable to complete the request. Check the server log and retry.'});
    }
  });
}

if(process.argv[1]?.endsWith('/server.ts')){
  const runtime=await AppRuntime.create({stateDir:process.env.VERITAS_STATE_DIR});
  const server=appServer(runtime),port=Number(process.env.PORT??8788);
  server.listen(port,'127.0.0.1',()=>console.log(`Veritas ${runtime.sampleMode?'SAMPLE_MODE':'LIVE'} (${runtime.dataMode}) at http://localhost:${port}`));
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{runtime.shutdown();server.close();server.closeAllConnections();});
}
