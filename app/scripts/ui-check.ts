import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [base='http://127.0.0.1:8788',out='/tmp/veritas-ui-screens',mode='standard']=process.argv.slice(2);
const cdpPort=process.env.CDP_PORT??'9337';
const tabs=await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as {type:string;webSocketDebuggerUrl:string}[];
const tab=tabs.find(t=>t.type==='page');if(!tab)throw new Error(`Start a separate headless Chrome on port ${cdpPort} first`);
const ws=new WebSocket(tab.webSocketDebuggerUrl),pending=new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void;timer:ReturnType<typeof setTimeout>}>();
let seq=0;
const errors:string[]=[];
ws.onmessage=event=>{
  const data=JSON.parse(String(event.data));
  if(data.id){const p=pending.get(data.id);if(p){clearTimeout(p.timer);pending.delete(data.id);data.error?p.reject(new Error(JSON.stringify(data.error))):p.resolve(data.result);}}
  if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.text+': '+(data.params.exceptionDetails.exception?.description??''));
};
await Promise.race([new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('CDP connection failed'));}),delay(5000).then(()=>{throw new Error('CDP connect timeout');})]);
async function send(method:string,params:unknown={}){const id=++seq;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression:string){const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;}
async function until(expression:string){const start=Date.now();while(Date.now()-start<10000){if(await evaluate(expression))return;await delay(50);}throw new Error(`UI wait timed out: ${expression}`);}
async function shot(name:string){await evaluate('document.fonts.ready');await delay(150);const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(out,`${name}.png`),Buffer.from(result.data,'base64'));console.log(`Captured ${name}.png`);}
await mkdir(out,{recursive:true});await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
try{
  await send('Page.navigate',{url:base+'/?qa='+Date.now()+'#/'});
  await until("document.querySelectorAll('#cohort-tbody tr[data-case-id]').length===11");
  if(mode==='result'){
    await evaluate("location.hash='#/case/1375365_2015-06-30'");
    await until("document.getElementById('case-heading').textContent.includes('Super Micro') && document.querySelector('#case-header-badges').textContent.includes('Live samples')");
    await shot('live-result');
  }else if(mode==='live'||mode.startsWith('resume:')){
    if(mode.startsWith('resume:')){
      const id=mode.slice(7);
      await evaluate(`sessionStorage.setItem('veritas-live-job',JSON.stringify({id:${JSON.stringify(id)},caseId:'1375365_2015-06-30',eventsUrl:'/api/runs/'+${JSON.stringify(id)}+'/events'}))`);
    }
    await evaluate("location.hash='#/case/1375365_2015-06-30'");
    await until("document.getElementById('case-heading').textContent.includes('Super Micro')");
    if(mode==='live')await evaluate("document.getElementById('btn-run-live').click()");
    await until("!document.getElementById('live-progress-card').classList.contains('hidden') && document.getElementById('live-progress-details').textContent.includes('Sample')");
    await shot('live-progress');
    console.log('A real three-sample live job is running; monitor server log until it terminates.');
  }else{
    await shot('cohort');
    await evaluate("document.getElementById('btn-toggle-reveal').click()");
    await until("document.querySelector('#btn-toggle-reveal').getAttribute('aria-pressed')==='true'");
    await shot('cohort-revealed');
    await evaluate("location.hash='#/case/1336917_2015-12-31'");
    await until("document.getElementById('case-heading').textContent.includes('Under Armour') && document.querySelectorAll('.finding-card').length>0");
    await shot('case');
    await evaluate("document.querySelector('.quarter-section').scrollIntoView({block:'start'})");await shot('quarter-comparison');
    await evaluate("document.querySelector('#view-case [data-eid=E30]').click()");
    await until("!document.getElementById('drawer-body').classList.contains('hidden')");
    await shot('drawer');
    await evaluate("document.querySelector('#drawer-origins-container details').open=true;document.querySelector('#drawer-origins-container').scrollIntoView({block:'start'})");await shot('drawer-sql-rows');
    await evaluate("document.getElementById('drawer-close').click();document.querySelector('.findings-section').scrollIntoView({block:'start'})");await shot('scorecard');
    await evaluate("document.querySelector('.finding-discussion').open=true");await shot('red-team-and-judge');
    await evaluate("document.getElementById('tab-sample-1').click()");await shot('sample-2');
    await evaluate("document.querySelector('.memory-section').scrollIntoView({block:'start'})");await shot('seen-before');
    await evaluate("document.querySelector('#memories-list [data-eid]').click()");await until("!document.getElementById('drawer-body').classList.contains('hidden')");
    if(!await evaluate("document.getElementById('drawer-title').textContent.includes('MiMedx')"))throw new Error('Prior memory evidence opened the wrong case');
    await shot('memory-evidence');await evaluate("document.getElementById('drawer-close').click()");
    await evaluate("location.hash='#/case/9999999_2015-12-31'");await until("document.querySelector('#view-not-found.active')!==null");await shot('error');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate("location.hash='#/case/1336917_2015-12-31'");await until("document.querySelector('#view-case.active') && document.getElementById('case-heading').textContent.includes('Under Armour')");await shot('mobile-case');
  }
  if(errors.length)throw new Error(`Browser exceptions: ${errors.join('\n')}`);
  console.log('No browser JavaScript exceptions.');
}finally{ws.close();}
