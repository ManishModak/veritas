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
  return Promise.all(runs.map(async r=>{
    const row=(await source.execute(query('mdna_index',r.cik,r.fy_end))).rows[0];
    if(!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.filed) || !row.accn || !row.url) throw new Error(`Missing filing identity for ${caseId(r.cik,r.fy_end)}`);
    return {caseId:caseId(r.cik,r.fy_end),cik:r.cik,company:r.company,fyEnd:r.fy_end,filed:row.filed,accn:row.accn,url:row.url};
  }));
}
