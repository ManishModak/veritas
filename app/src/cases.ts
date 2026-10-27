import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNS } from './paths.ts';
import type { CaseRun } from './agent/types.ts';
import type { FactsSource } from './data/source.ts';
import { query } from './data/queries.ts';

export interface FilingIdentity { caseId: string; cik: number; company: string; fyEnd: string; filed: string; accn: string; url: string }
export const caseId = (cik: number, fyEnd: string) => `${cik}_${fyEnd}`;
const DEV = new Set(['1336917_2015-12-31','1065837_2019-12-31','40704_2019-05-26']);
export const cohortSplit = (id: string) => DEV.has(id) ? 'development' : 'blind';

export async function recordedCases(): Promise<CaseRun[]> {
  return Promise.all((await readdir(RUNS)).filter(f=>/^\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(async f=>JSON.parse(await readFile(join(RUNS,f),'utf8')) as CaseRun));
}

// Build the trusted filing catalogue from the data source, never from request-supplied dates or memory metadata.
export async function filingCatalogue(source: FactsSource, runs: CaseRun[]): Promise<FilingIdentity[]> {
  return Promise.all(runs.map(r=>filingIdentity(source,r.cik,r.fy_end,r.company)));
}

// One case's filing identity (10-K filed date, accession, URL) from the source's mdna_index table.
export async function filingIdentity(source: FactsSource, cik: number, fyEnd: string, company: string): Promise<FilingIdentity> {
  const row=(await source.execute(query('mdna_index',cik,fyEnd))).rows[0];
  if(!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.filed) || !row.accn || !row.url) throw new Error(`Missing filing identity for ${caseId(cik,fyEnd)}`);
  return {caseId:caseId(cik,fyEnd),cik,company,fyEnd,filed:row.filed,accn:row.accn,url:row.url};
}

export interface AddedCompany { id: string; cik: number; company: string; fyEnd: string; dir: string }
// Company-years added with data/add_company.py, one folder each with meta.json, oldest first.
export async function addedCompanies(dir: string): Promise<AddedCompany[]> {
  let names:string[];try{names=(await readdir(dir)).filter(n=>/^\d+_\d{4}-\d{2}-\d{2}$/.test(n)).sort();}catch{return [];}
  const out:AddedCompany[]=[];
  for(const name of names){
    try{const m=JSON.parse(await readFile(join(dir,name,'meta.json'),'utf8'));if(m.id===name)out.push({id:name,cik:m.cik,company:m.company,fyEnd:m.fy_end,dir:join(dir,name)});}catch{}
  }
  return out;
}
