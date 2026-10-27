import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ROOT } from './paths.ts';
import type { EvidencePack } from './agent/evidence.ts';

export const TRACE = resolve(ROOT, 'logs/agent-trace.jsonl');
export interface TraceEvent { agent_name: string; action: string; [key: string]: unknown }
export type Trace = (event: TraceEvent) => void;

// Default sink for real runs: one timestamped JSONL line to stdout and logs/agent-trace.jsonl, appended in call order.
// Tracing never fails a run.
let writes = Promise.resolve();
export const traceToLog: Trace = event => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  console.log(line);
  writes = writes.then(() => mkdir(dirname(TRACE), { recursive: true })).then(() => appendFile(TRACE, line + '\n')).catch(() => {});
};

// One line per SQL query behind a case's evidence pack: the data source that ran it, the rows the agents get and the evidence ids citing it.
export function traceEvidence(trace: Trace, pack: EvidencePack, base: Record<string, unknown>): void {
  const bySql = new Map<string, { table: string; mode: string; rows: Set<unknown>; ids: string[] }>();
  for (const [id, origin] of Object.entries(pack.origins)) for (const q of origin.queries) {
    const entry = bySql.get(q.sql) ?? { table: q.table, mode: q.mode, rows: new Set(), ids: [] };
    q.rows.forEach(r => entry.rows.add(r)); entry.ids.push(id); bySql.set(q.sql, entry);
  }
  for (const [sql, q] of bySql) trace({ agent_name: q.mode === 'zetaris' ? 'zetaris' : 'csv_source', action: 'query', ...base, table: q.table, rows_used: q.rows.size, evidence_ids: q.ids, sql });
}
