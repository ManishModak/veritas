import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCsv, type Row } from './csv.ts';
import type { Query, Table } from './queries.ts';
import { COMPANY_TABLES, dateColumn, type FactsSource, type QueryResult } from './source.ts';

export const BENEISH_FLOATS=['dsri','gmi','aqi','sgi','depi','sgai','tata','lvgi','m_score'];

// Python CSV float repr keeps .0 for integer-valued indices and uses a two-digit exponent.
export function pythonFloat(value:number):string{
  if(!Number.isFinite(value))throw new Error('Non-finite Zetaris numeric value');
  if(Object.is(value,-0))return '-0.0';
  const n=Math.abs(value);
  if(n!==0&&(n<1e-4||n>=1e16)){
    const [digits,exponent]=value.toExponential().split('e'),exp=Number(exponent);
    return `${digits}e${exp<0?'-':'+'}${String(Math.abs(exp)).padStart(2,'0')}`;
  }
  return Number.isInteger(value)?value.toFixed(1):String(value);
}

// All bridge transport types are normalized here; evidence formatting remains source-agnostic.
export function normalizeRows(table:Table,columns:string[],rows:unknown[][]):Row[]{
  return rows.map(values=>{
    if(values.length!==columns.length)throw new Error('Zetaris bridge column count mismatch');
    const row:Row={};
    columns.forEach((column,i)=>{
      if(column==='role'||column==='enforcement')return;
      const value=values[i];
      if(value===null||value===undefined){row[column]='';return;}
      if(column==='derived'||column==='flagged'){
        const flag=String(value).toLowerCase();
        if(flag==='true'||flag==='1')row[column]='True';
        else if(flag==='false'||flag==='0')row[column]='False';
        else if(flag==='')row[column]='';
        else throw new Error('Unexpected Zetaris flag value');
        return;
      }
      if(typeof value==='boolean'){row[column]=value?'True':'False';return;}
      if((table==='beneish'||table==='cohort')&&BENEISH_FLOATS.includes(column)){
        row[column]=value===''?'':pythonFloat(Number(value));return;
      }
      if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Non-finite Zetaris numeric value');
      if(typeof value!=='number'&&typeof value!=='string')throw new Error('Unexpected Zetaris cell type');
      row[column]=String(value);
    });
    return row;
  });
}

const REQUIRED:Record<Table,string[]>={
  facts:['cik','company','fy_end','concept','tag','value','accn','filed'],
  quarters:['cik','fy_end','q_end','revenue','receivables','derived','rev_accn','rev_filed','ar_accn','ar_filed'],
  beneish:['cik','fy_end',...BENEISH_FLOATS,'flagged'],
  mdna_index:['cik','company','period','filed','accn','url'],
  mdna_paragraphs:['cik','period','para_no','text','url'],
  cohort:['cik','company','fy_end','sic','industry',...BENEISH_FLOATS,'flagged'],
};

// Execute the centralized SQL verbatim through the real bridge. Fail loudly; never fall back to CSV.
export class ZetarisSource implements FactsSource{
  private endpoint:string;
  constructor(bridgeUrl=process.env.ZETARIS_BRIDGE_URL,private options:{fetch?:typeof fetch;timeoutMs?:number}={}){
    if(!bridgeUrl)throw new Error('Zetaris mode requires ZETARIS_BRIDGE_URL');
    const url=new URL(bridgeUrl);if(!['http:','https:'].includes(url.protocol))throw new Error('Invalid Zetaris bridge URL');
    this.endpoint=bridgeUrl.replace(/\/$/,'')+'/sql';
  }
  async execute(q:Query):Promise<QueryResult>{
    let response:Response;
    try{response=await(this.options.fetch??fetch)(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql:q.sql}),signal:AbortSignal.timeout(this.options.timeoutMs??60000)});}
    catch{throw new Error(`Zetaris bridge unavailable or timed out (${q.table}); check the tunnel and bridge.`);}
    if(!response.ok){await response.body?.cancel();throw new Error(`Zetaris SQL failed with HTTP ${response.status} (${q.table}); check the bridge log.`);}
    let payload:any;try{payload=await response.json();}catch{throw new Error('Zetaris bridge returned invalid JSON or timed out reading its response');}
    if(!Array.isArray(payload.columns)||!payload.columns.every((c:unknown)=>typeof c==='string')||new Set(payload.columns).size!==payload.columns.length||!Array.isArray(payload.rows)||!payload.rows.every(Array.isArray))throw new Error('Invalid Zetaris bridge response shape');
    if(REQUIRED[q.table].some(c=>!payload.columns.includes(c)))throw new Error(`Zetaris response missing columns for ${q.table}`);
    return {sql:q.sql,rows:normalizeRows(q.table,payload.columns,payload.rows),mode:'zetaris',label:'executed on Zetaris',table:q.table};
  }
  // Send each table of an added company-year to the bridge's /load, which replaces that CIK's rows for those dates.
  async addCompany(dir:string):Promise<void>{
    for(const table of COMPANY_TABLES){
      const csv=await readFile(join(dir,`${table}.csv`),'utf8'),rows=parseCsv(csv);
      if(!rows.length)continue;
      const body={table,csv,cik:Number(rows[0].cik),dates:[...new Set(rows.map(r=>r[dateColumn(table)]))]};
      let response:Response;
      try{response=await(this.options.fetch??fetch)(this.endpoint.replace(/\/sql$/,'/load'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(this.options.timeoutMs??60000)});}
      catch{throw new Error(`Zetaris bridge unavailable or timed out loading ${table}; check the tunnel and bridge.`);}
      if(!response.ok){await response.body?.cancel();throw new Error(`Zetaris load failed with HTTP ${response.status} (${table}); check the bridge log.`);}
      await response.body?.cancel();
    }
  }
}
