import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, GENERATED } from '../paths.ts';
import { parseCsv, type Row } from './csv.ts';
import { selectRows, type Query } from './queries.ts';

export interface QueryResult { sql: string; rows: Row[]; mode: 'csv' | 'zetaris'; label: string; table: string }
// addCompany loads one data/add_company.py folder; its rows replace that company's rows for the same dates.
export interface FactsSource { execute(query: Query): Promise<QueryResult>; addCompany?(dir: string): Promise<void> }
export const COMPANY_TABLES = ['facts', 'quarters', 'beneish', 'mdna_index', 'mdna_paragraphs'] as const;
export const dateColumn = (table: string) => table.startsWith('mdna_') ? 'period' : 'fy_end';
const rowKey = (table: string, r: Row) => `${Number(r.cik)}|${r[dateColumn(table)]}`;

export class CsvSource implements FactsSource {
  private files = new Map<string, Promise<Row[]>>();
  private added = new Map<string, Row[]>();
  constructor(private dataDir = DATA, private generatedDir = GENERATED) {}
  async execute(q: Query): Promise<QueryResult> {
    const dir = q.table.startsWith('mdna_') ? this.generatedDir : this.dataDir;
    const table = q.table==='cohort'?'beneish':q.table;
    const file = join(dir, `${table}.csv`);
    if (!this.files.has(file)) this.files.set(file, readFile(file, 'utf8').then(parseCsv).catch(e => { this.files.delete(file); throw e; }));
    const extra = this.added.get(table) ?? [], keys = new Set(extra.map(r => rowKey(table, r)));
    const all = extra.length ? [...(await this.files.get(file)!).filter(r => !keys.has(rowKey(table, r))), ...extra] : await this.files.get(file)!;
    const rows = selectRows(all, q);
    // Labels and enforcement metadata never cross the data boundary into the agent or memory.
    return { sql: q.sql, rows: rows.map(({ role, enforcement, ...r }) => q.table==='cohort'?{...r,industry:''}:r), mode: 'csv', label: 'equivalent SQL (CSV mode)', table: q.table };
  }
  async addCompany(dir: string): Promise<void> {
    for (const table of COMPANY_TABLES) {
      const rows = parseCsv(await readFile(join(dir, `${table}.csv`), 'utf8')), keys = new Set(rows.map(r => rowKey(table, r)));
      this.added.set(table, [...(this.added.get(table) ?? []).filter(r => !keys.has(rowKey(table, r))), ...rows]);
    }
  }
}
