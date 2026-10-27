import { appendFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../paths.ts';
import type { EvidencePack } from './evidence.ts';
import { INVESTIGATOR, RED_TEAM, JUDGE } from './prompts.ts';
import { MODEL, nimClient, provider, type Ask } from './nim.ts';
import type { CallRecord, CaseRun, Grounding, Investigator, Judge, Progress, RedTeam, Sample, Stage } from './types.ts';

export function grounding(result: Record<string, any>, key: string, ids: Set<string>): Grounding {
  const cited = (result[key] ?? []).flatMap((item: { evidence?: string[] }) => item.evidence ?? []);
  return { citations: cited.length, unknown_ids: cited.filter((id: string) => !ids.has(id)), uncited: (result[key] ?? []).filter((item: { evidence?: string[] }) => !item.evidence?.length).length };
}

// Reject malformed stage output instead of allowing a vacuous grounding pass. Unknown verdict labels remain valid text.
export function validateStage(stage: Stage, value: Record<string, any>): void {
  const key = stage === 'investigator' ? 'findings' : stage === 'red_team' ? 'rebuttals' : 'rulings';
  const verdict = stage === 'investigator' ? 'verdict' : stage === 'judge' ? 'final_verdict' : 'overall';
  if (typeof value[verdict] !== 'string' || !Array.isArray(value[key]) || value[key].length === 0) throw new Error(`Invalid ${stage} schema: missing ${verdict} or ${key}`);
  const strings = (items: unknown) => Array.isArray(items) && items.every(v => typeof v === 'string');
  for (const row of value[key]) {
    if (!row || !strings(row.evidence)) throw new Error(`Invalid ${stage} evidence array`);
    const fields = stage === 'investigator' ? ['management_says','numbers_show','fit'] : stage === 'red_team' ? ['innocent_explanation','support'] : ['ruling','reason'];
    if (fields.some(f => typeof row[f] !== 'string')) throw new Error(`Invalid ${stage} finding fields`);
    if (stage !== 'investigator' && (!Number.isInteger(row.finding_index) || row.finding_index < 0)) throw new Error(`Invalid ${stage} finding index`);
  }
  if (stage === 'investigator' && (typeof value.summary !== 'string' || !strings(value.questions_for_management) || !strings(value.what_would_change_my_mind))) throw new Error('Invalid investigator summary/questions');
  if (stage === 'judge' && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || typeof value.deciding_evidence !== 'string' || !strings(value.evidence_that_would_settle_it))) throw new Error('Invalid judge confidence/settling evidence');
}

export function evidenceHead(pack: Pick<EvidencePack,'company' | 'evidence'>): string {
  return `Company: ${pack.company}\nEvidence pack:\n${pack.evidence.map(it => `[${it.id}] (${it.kind}) ${it.text}  -- source: ${it.source}`).join('\n')}`;
}

function validateReferences(value: {finding_index:number}[], count: number): void {
  if (value.some(r => r.finding_index >= count)) throw new Error('Stage refers to an out-of-range finding');
  if (value.length !== count || new Set(value.map(r=>r.finding_index)).size !== count) throw new Error('Every finding needs exactly one rebuttal and ruling');
}

// Execute one sample across investigator -> red-team -> judge stages in strict sequence.
export async function runOnce(head: string, ids: Set<string>, ask: Ask, onStage?: (stage: Stage, status: 'started' | 'completed', elapsedMs: number) => void, signal?: AbortSignal): Promise<Sample> {
  const stage = async (name: Stage, system: string, user: string) => {
    signal?.throwIfAborted();
    const started = Date.now(); onStage?.(name, 'started', 0);
    const value = await ask(system, user, signal);
    signal?.throwIfAborted();
    validateStage(name, value);
    onStage?.(name, 'completed', Date.now() - started);
    return value;
  };
  const investigator = await stage('investigator', INVESTIGATOR, head) as unknown as Investigator;
  const red_team = await stage('red_team', RED_TEAM, `${head}\n\nInvestigator findings:\n${JSON.stringify(investigator)}`) as unknown as RedTeam;
  validateReferences(red_team.rebuttals,investigator.findings.length);
  const judge = await stage('judge', JUDGE, `${head}\n\nInvestigator findings:\n${JSON.stringify(investigator)}\n\nDefender rebuttals:\n${JSON.stringify(red_team)}`) as unknown as Judge;
  validateReferences(judge.rulings,investigator.findings.length);
  return { investigator, red_team, judge, grounding: {
    investigator: grounding(investigator, 'findings', ids), red_team: grounding(red_team, 'rebuttals', ids), judge: grounding(judge, 'rulings', ids),
  } };
}

export function agreement(samples: Sample[]): CaseRun['agreement'] {
  const count = (values: string[]) => Object.fromEntries([...new Set(values)].map(v => [v, values.filter(x => x === v).length]));
  return { investigator: count(samples.map(s => s.investigator.verdict ?? '?')), judge: count(samples.map(s => s.judge.final_verdict ?? '?')) };
}

export const TRACE = resolve(ROOT, 'logs/agent-trace.jsonl');

// Append one JSONL trace line per answered model request (stdout too), so the log shows which model did each agent's work.
async function trace(company: string, fyEnd: string, call: CallRecord): Promise<void> {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), agent_name: call.stage, sample: call.sample, company, fy_end: fyEnd,
    provider: call.provider, model: call.model, latency_ms: call.ms, receipt: call.receipt, status: call.status });
  console.log(line);
  try { await mkdir(dirname(TRACE), { recursive: true }); await appendFile(TRACE, line + '\n'); } catch { /* tracing never fails a run */ }
}

// Independent samples run in parallel against immutable evidence; failure or abort cancels all in-flight requests.
export async function runCase(cik: number, fyEnd: string, pack: EvidencePack, options: { samples?: number; ask?: Ask; progress?: (p: Progress) => void; signal?: AbortSignal } = {}): Promise<CaseRun> {
  const total = options.samples ?? 3;
  if (!Number.isInteger(total) || total < 1 || total > 3) throw new Error('Samples must be 1, 2 or 3');
  options.signal?.throwIfAborted();
  const head = evidenceHead(pack), ids = new Set(pack.evidence.map(e=>e.id));
  const internal = new AbortController();
  const combined = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal;
  let firstError: unknown = null;
  const calls: CallRecord[] = [];
  const tasks = Array.from({ length: total }, async (_, i) => {
    const sample = i + 1;
    let activeStage: Stage = 'investigator';
    const ask = options.ask ?? nimClient({
      signal: combined,
      onRetry: attempt => options.progress?.({ sample, total, stage: activeStage, status: 'retry', attempt }),
      onResponse: call => { const record = { sample, stage: activeStage, ...call }; calls.push(record); void trace(pack.company, fyEnd, record); },
    });
    try {
      return await runOnce(
        head,
        ids,
        ask,
        (stage, status, elapsedMs) => {
          activeStage = stage;
          options.progress?.({ sample, total, stage, status, elapsedMs });
        },
        combined
      );
    } catch (err) {
      if (!firstError) firstError = err;
      internal.abort();
      throw err;
    }
  });
  const settled = await Promise.allSettled(tasks);
  if (firstError) throw firstError;
  const samples = settled.map(s => {
    if (s.status === 'fulfilled') return s.value;
    throw s.reason;
  });
  const models = [...new Set(calls.map(c => c.model))];
  return { cik, company: pack.company, fy_end: fyEnd, model: models.length === 1 ? models[0] : options.ask ? MODEL : models.join(', ') || provider().model,
    evidence: pack.evidence, samples, agreement: agreement(samples), ...(calls.length ? { provider: calls[0].provider, calls } : {}) };
}

export async function saveRun(file: string, run: CaseRun): Promise<void> {
  assertRunGrounded(run);
  await mkdir(dirname(file), {recursive:true});
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(run,null,2) + '\n');
  await rename(tmp,file);
}

// Gate persistence on fresh checks, rather than trusting serialized grounding metadata.
export function assertRunGrounded(run: CaseRun): void {
  if (!run.samples.length) throw new Error('Cannot save a run without samples');
  const ids = new Set(run.evidence.map(e=>e.id));
  for (const sample of run.samples) for (const [stage,key] of [['investigator','findings'],['red_team','rebuttals'],['judge','rulings']] as const) {
    validateStage(stage,sample[stage]);
    if (stage === 'red_team') validateReferences(sample.red_team.rebuttals,sample.investigator.findings.length);
    if (stage === 'judge') validateReferences(sample.judge.rulings,sample.investigator.findings.length);
    const check = grounding(sample[stage],key,ids);
    if (check.unknown_ids.length || check.uncited) throw new Error(`Citation check failed for ${stage}; no result saved`);
  }
}
