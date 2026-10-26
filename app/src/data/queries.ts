import type { Row } from './csv.ts';

export const CONCEPTS = ['revenue', 'cogs', 'sga', 'depreciation', 'net_income', 'cfo', 'receivables', 'current_assets', 'ppe', 'assets', 'current_liabilities', 'lt_debt'];
export type Table = 'facts' | 'quarters' | 'beneish' | 'mdna_index' | 'mdna_paragraphs' | 'cohort';
export interface Query { table: Table; cik?: number; period?: string; sql: string }
const schemaName=(schema:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))throw new Error('Invalid Zetaris schema');return schema;};

// All evidence SQL is defined here; schema and literals are validated before interpolation.
export function query(table: Exclude<Table,'cohort'>, cik: number, period?: string, schema = process.env.ZETARIS_SCHEMA ?? 'veritas_pg'): Query {
  if (!Number.isSafeInteger(cik) || cik <= 0) throw new Error('Invalid CIK');
  schemaName(schema);
  if (period && !/^\d{4}-\d{2}-\d{2}$/.test(period)) throw new Error('Invalid fiscal period');
  const dateColumn = table.startsWith('mdna_') ? 'period' : 'fy_end';
  const order = table === 'facts' ? `fy_end, CASE concept ${CONCEPTS.map((c, i) => `WHEN '${c}' THEN ${i}`).join(' ')} ELSE 99 END`
    : table === 'quarters' ? 'fy_end, q_end' : table === 'mdna_paragraphs' ? 'para_no' : dateColumn;
  return { table, cik, period, sql: `SELECT * FROM ${schema}.${table} WHERE cik = ${cik}${period ? ` AND ${dateColumn} = '${period}'` : ''} ORDER BY ${order}` };
}

// One Lightning SQL statement federates Postgres company-years with the REST-backed SIC view.
export function cohortQuery(schema=process.env.ZETARIS_SCHEMA??'veritas_pg'):Query{
  return {table:'cohort',sql:`SELECT b.*, s.name AS industry FROM ${schemaName(schema)}.beneish b LEFT JOIN company_dns.sic_names s ON b.sic = s.code ORDER BY b.cik, b.fy_end`};
}

export function selectRows(rows: Row[], q: Query): Row[] {
  const dateColumn = q.table.startsWith('mdna_') ? 'period' : 'fy_end';
  return rows.filter(r => (q.cik===undefined||Number(r.cik) === q.cik) && (!q.period || r[dateColumn] === q.period)).sort((a,b) => {
    if(q.table==='cohort'&&a.cik!==b.cik)return Number(a.cik)-Number(b.cik);
    if (q.table === 'mdna_paragraphs') return Number(a.para_no) - Number(b.para_no);
    const date = a[dateColumn].localeCompare(b[dateColumn]);
    if (date) return date;
    const rank = (concept: string) => { const i = CONCEPTS.indexOf(concept); return i < 0 ? 99 : i; };
    if (q.table === 'facts') return rank(a.concept) - rank(b.concept);
    if (q.table === 'quarters') return a.q_end.localeCompare(b.q_end);
    return 0;
  });
}
