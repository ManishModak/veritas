import type { Row } from './csv.ts';

export const CONCEPTS = ['revenue', 'cogs', 'sga', 'depreciation', 'net_income', 'cfo', 'receivables', 'current_assets', 'ppe', 'assets', 'current_liabilities', 'lt_debt'];
export type Table = 'facts' | 'quarters' | 'beneish' | 'mdna_index' | 'mdna_paragraphs';
export interface Query { table: Table; cik: number; period?: string; sql: string }

// All evidence SQL is defined here; schema and literals are validated before interpolation.
export function query(table: Table, cik: number, period?: string, schema = process.env.ZETARIS_SCHEMA ?? 'veritas_pg'): Query {
  if (!Number.isSafeInteger(cik) || cik <= 0) throw new Error('Invalid CIK');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('Invalid Zetaris schema');
  if (period && !/^\d{4}-\d{2}-\d{2}$/.test(period)) throw new Error('Invalid fiscal period');
  const dateColumn = table.startsWith('mdna_') ? 'period' : 'fy_end';
  const order = table === 'facts' ? `fy_end, CASE concept ${CONCEPTS.map((c, i) => `WHEN '${c}' THEN ${i}`).join(' ')} ELSE 99 END`
    : table === 'quarters' ? 'fy_end, q_end' : table === 'mdna_paragraphs' ? 'para_no' : dateColumn;
  return { table, cik, period, sql: `SELECT * FROM ${schema}.${table} WHERE cik = ${cik}${period ? ` AND ${dateColumn} = '${period}'` : ''} ORDER BY ${order}` };
}

export function selectRows(rows: Row[], q: Query): Row[] {
  const dateColumn = q.table.startsWith('mdna_') ? 'period' : 'fy_end';
  return rows.filter(r => Number(r.cik) === q.cik && (!q.period || r[dateColumn] === q.period)).sort((a,b) => {
    if (q.table === 'mdna_paragraphs') return Number(a.para_no) - Number(b.para_no);
    const date = a[dateColumn].localeCompare(b[dateColumn]);
    if (date) return date;
    if (q.table === 'facts') return CONCEPTS.indexOf(a.concept) - CONCEPTS.indexOf(b.concept);
    if (q.table === 'quarters') return a.q_end.localeCompare(b.q_end);
    return 0;
  });
}
