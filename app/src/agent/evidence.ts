import { query } from '../data/queries.ts';
import type { FactsSource, QueryResult } from '../data/source.ts';
import type { Row } from '../data/csv.ts';

export interface Evidence { id: string; kind: 'fact' | 'signal' | 'mdna'; text: string; source: string }
export interface EvidenceOrigin { queries: QueryResult[]; rows: Row[] }
export interface EvidencePack { company: string; evidence: Evidence[]; origins: Record<string, EvidenceOrigin>; filing: Row; prior: string }
const KEYWORDS = /net revenues?|net sales|revenue growth|receivable|cash (provided|flows?) from operat|wholesale|direct.to.consumer|lease|842|right.of.use|days sales|inventor/i;

// Match Python fixed-point rounding, including ties-to-even, on the actual IEEE-754 value.
export function fixed(value: number, digits: number, comma = false): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite evidence value');
  const negative = value < 0 || Object.is(value, -0);
  const buf = new DataView(new ArrayBuffer(8)); buf.setFloat64(0, Math.abs(value));
  const bits = buf.getBigUint64(0), exp = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exp ? 1n << 52n : 0n);
  const power = (exp ? exp - 1023 : -1022) - 52;
  let numerator = mantissa * (10n ** BigInt(digits)), denominator = 1n;
  if (power >= 0) numerator <<= BigInt(power); else denominator <<= BigInt(-power);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n === 1n)) rounded++;
  const s = rounded.toString().padStart(digits + 1, '0');
  let integer = digits ? s.slice(0, -digits) : s;
  if (comma) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${integer}${digits ? '.' + s.slice(-digits) : ''}`;
}
const million = (v: number) => fixed(v / 1e6, 1, true);
const signed = (v: number) => `${v >= 0 ? '+' : ''}${fixed(v, 1)}`;

// Compute evidence only from the supplied data source; recorded runs are test oracles, never inputs.
export async function evidencePack(source: FactsSource, cik: number, fyEnd: string): Promise<EvidencePack> {
  const [facts, quarters, beneish, index, paragraphs] = await Promise.all([
    source.execute(query('facts', cik)), source.execute(query('quarters', cik)),
    source.execute(query('beneish', cik, fyEnd)), source.execute(query('mdna_index', cik, fyEnd)),
    source.execute(query('mdna_paragraphs', cik, fyEnd)),
  ]);
  if (!facts.rows.length) throw new Error(`Unknown CIK: ${cik}`);
  const ends = [...new Set(facts.rows.map(r => r.fy_end))].sort();
  const yearIndex = ends.indexOf(fyEnd);
  if (yearIndex < 1) throw new Error(`No prior fiscal year for ${cik} ${fyEnd}`);
  const prior = ends[yearIndex - 1], filing = index.rows[0], b = beneish.rows[0];
  if (!filing || !b || !paragraphs.rows.length) throw new Error(`Missing filing data for ${cik} ${fyEnd}; run npm run setup`);
  const evidence: Evidence[] = [], origins: Record<string, EvidenceOrigin> = {};
  const add = (kind: Evidence['kind'], text: string, src: string, queries: QueryResult[], rows: Row[]) => {
    const id = `E${evidence.length + 1}`;
    evidence.push({ kind, text, source: src, id });
    origins[id] = { queries: queries.map(q => ({ ...q, rows: q.rows.filter(r => rows.includes(r)) })), rows };
  };
  const used = facts.rows.filter(r => [prior, fyEnd].includes(r.fy_end));
  for (const r of used) add('fact', `${r.concept} for fiscal year ending ${r.fy_end} = $${million(Number(r.value))}M (XBRL tag ${r.tag})`, `10-K accession ${r.accn}, filed ${r.filed}`, [facts], [r]);
  const get = (end: string, concept: string) => { const r = facts.rows.find(r => r.fy_end === end && r.concept === concept); return r ? Number(r.value) : undefined; };
  const t = (c: string) => get(fyEnd, c), p = (c: string) => get(prior, c);
  const factRows = (concepts: string[]) => used.filter(r => concepts.includes(r.concept));
  if (['revenue','receivables'].every(k => t(k) && p(k))) {
    add('signal', `Revenue growth ${fixed(100 * (t('revenue')! / p('revenue')! - 1), 1)}% vs receivables growth ${fixed(100 * (t('receivables')! / p('receivables')! - 1), 1)}%; days sales outstanding ${fixed(365 * p('receivables')! / p('revenue')!, 0)} -> ${fixed(365 * t('receivables')! / t('revenue')!, 0)} days`, 'computed from the revenue and receivables facts', [facts], factRows(['revenue','receivables']));
  }
  if (['net_income','cfo'].every(k => t(k) !== undefined && p(k) !== undefined)) {
    add('signal', `Net income $${million(p('net_income')!)}M -> $${million(t('net_income')!)}M while operating cash flow $${million(p('cfo')!)}M -> $${million(t('cfo')!)}M`, 'computed from the net income and cash-flow facts', [facts], factRows(['net_income','cfo']));
  }
  const cur = quarters.rows.filter(r => r.fy_end === fyEnd), old = quarters.rows.filter(r => r.fy_end === prior);
  const ok = (rows: Row[], annual?: number) => rows.length === 4 && rows.every(r => r.receivables) && annual && Math.abs(rows.reduce((s,r) => s + Number(r.revenue), 0) / annual - 1) <= 0.02;
  if (!ok(cur, t('revenue')) || !ok(old, p('revenue'))) {
    add('signal', 'Quarterly revenue/receivables data is incomplete for this year; no quarter-level comparison.', '10-Q/10-K XBRL facts', [quarters, facts], [...cur, ...old, ...factRows(['revenue'])]);
  } else cur.forEach((c,i) => {
    const o = old[i], rc = Number(c.revenue), ro = Number(o.revenue), ac = Number(c.receivables), ao = Number(o.receivables);
    add('signal', `Fiscal Q${i+1} (quarter ending ${c.q_end}): revenue $${million(rc)}M vs $${million(ro)}M a year earlier (${signed(100 * (rc/ro-1))}%); quarter-end receivables $${million(ac)}M vs $${million(ao)}M (${signed(100 * (ac/ao-1))}%); quarter-end DSO ${fixed(91*ao/ro,0)} -> ${fixed(91*ac/rc,0)} days${c.derived === 'True' ? ' (Q4 revenue derived as annual minus 9-month YTD)' : ''}`, `10-Q/10-K accessions ${c.rev_accn}, ${c.ar_accn} (and prior-year ${o.rev_accn})`, [quarters], [c,o]);
  });
  if (b.m_score) add('signal', `Beneish M-score = ${b.m_score} (flag threshold -1.78; flagged=${b.flagged}). Indices: DSRI=${b.dsri} GMI=${b.gmi} AQI=${b.aqi} SGI=${b.sgi} DEPI=${b.depi} SGAI=${b.sgai} TATA=${b.tata} LVGI=${b.lvgi}`, 'computed from the facts above (Beneish 1999)', [beneish, facts], [b, ...used]);
  for (const r of paragraphs.rows.filter(r => [...r.text].length > 120 && [...r.text].length < 1500 && KEYWORDS.test(r.text)).slice(0,25)) {
    add('mdna', r.text, `10-K MD&A, ${filing.url}`, [index, paragraphs], [filing,r]);
  }
  return { company: facts.rows[0].company, evidence, origins, filing, prior };
}
