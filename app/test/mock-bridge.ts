import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, GENERATED } from '../src/paths.ts';
import { parseCsv } from '../src/data/csv.ts';
import { BENEISH_FLOATS } from '../src/data/zetaris.ts';

// Independent SQL executor: load CSVs into typed SQLite tables and execute the actual bridge SQL.
export async function mockBridge(){
  const db=new DatabaseSync(':memory:');db.exec("ATTACH DATABASE ':memory:' AS veritas_pg; ATTACH DATABASE ':memory:' AS company_dns");
  for(const table of ['facts','quarters','beneish','mdna_index','mdna_paragraphs']){
    const rows=parseCsv(await readFile(join(table.startsWith('mdna_')?GENERATED:DATA,`${table}.csv`),'utf8'));
    const columns=Object.keys(rows[0]);
    const numeric=(c:string)=>c==='cik'||c==='para_no'||c==='chars'||(table==='facts'&&c==='value')||(table==='quarters'&&['revenue','receivables','derived'].includes(c))||(table==='beneish'&&BENEISH_FLOATS.includes(c));
    db.exec(`CREATE TABLE veritas_pg.${table} (${columns.map(c=>`"${c}" ${numeric(c)?'REAL':'TEXT'}`).join(',')})`);
    const insert=db.prepare(`INSERT INTO veritas_pg.${table} VALUES (${columns.map(()=>'?').join(',')})`);
    for(const row of rows)insert.run(...columns.map(c=>row[c]===''?null:c==='derived'?(row[c]==='True'?1:0):numeric(c)?Number(row[c]):row[c]));
  }
  db.exec('CREATE TABLE company_dns.sic_names (code TEXT, name TEXT, level TEXT)');
  const insert=db.prepare('INSERT INTO company_dns.sic_names VALUES (?,?,?)');
  for(const [code,name] of [['2300','Apparel'],['3021','Rubber and plastics footwear'],['3674','Semiconductors and related devices']])insert.run(code,name,'class');
  const executed:string[]=[];
  let flagMode:'number'|'boolean'|'string'='number';
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/sql'){res.writeHead(404).end();return;}
    try{
      let body='';for await(const chunk of req)body+=chunk;
      const {sql}=JSON.parse(body);if(typeof sql!=='string'||!/^SELECT\s/i.test(sql))throw new Error('Only SELECT SQL is allowed');
      executed.push(sql);const statement=db.prepare(sql),columns=statement.columns().map(c=>c.name);
      const rows=statement.all().map(row=>columns.map(c=>c==='derived'&&row[c]!==null?(flagMode==='boolean'?Boolean(row[c]):flagMode==='string'?String(Boolean(row[c])).toLowerCase():row[c]):row[c]));
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({columns,rows}));
    }catch{res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Mock SQL execution failed'}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Mock bridge did not bind');
  return {url:`http://127.0.0.1:${address.port}`,db,executed,setFlagMode:(mode:typeof flagMode)=>{flagMode=mode;},close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();}};
}
