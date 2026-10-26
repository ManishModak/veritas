import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, GENERATED } from '../paths.ts';
import { parseCsv, type Row } from './csv.ts';
import { selectRows, type Query } from './queries.ts';

export interface QueryResult { sql: string; rows: Row[]; mode: 'csv' | 'zetaris'; label: string; table: string }
export interface FactsSource { execute(query: Query): Promise<QueryResult> }

export class CsvSource implements FactsSource {
  constructor(private dataDir = DATA, private generatedDir = GENERATED) {}
  async execute(q: Query): Promise<QueryResult> {
    const dir = q.table.startsWith('mdna_') ? this.generatedDir : this.dataDir;
    const rows = selectRows(parseCsv(await readFile(join(dir, `${q.table}.csv`), 'utf8')), q);
    // Labels and enforcement metadata never cross the data boundary into the agent or memory.
    return { sql: q.sql, rows: rows.map(({ role, enforcement, ...r }) => r), mode: 'csv', label: 'equivalent SQL (CSV mode)', table: q.table };
  }
}
