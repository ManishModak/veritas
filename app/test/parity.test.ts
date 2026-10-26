import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CsvSource, type FactsSource } from '../src/data/source.ts';
import { evidencePack, fixed } from '../src/agent/evidence.ts';
import { parseCsv, toCsv } from '../src/data/csv.ts';
import { RUNS } from '../src/paths.ts';
import { splitParagraphs } from '../scripts/setup.ts';
import { query, selectRows } from '../src/data/queries.ts';

for (const file of (await readdir(RUNS)).filter(f => f.endsWith('.json'))) {
  test(`CSV computes exact Python evidence: ${file}`, async () => {
    const recorded = JSON.parse(await readFile(join(RUNS, file), 'utf8'));
    const actual = await evidencePack(new CsvSource(), recorded.cik, recorded.fy_end);
    assert.equal(actual.company, recorded.company);
    assert.deepEqual(actual.evidence, recorded.evidence);
    assert.deepEqual(Object.keys(actual.origins), actual.evidence.map(e => e.id));
    for (const ev of actual.evidence) {
      const origin = actual.origins[ev.id];
      assert(origin, `Missing origin for ${ev.id}`);
      assert(origin.queries.length > 0 && origin.rows.length > 0);
      assert(origin.queries.every(q => q.sql.includes(`cik = ${recorded.cik}`)));
      assert(!JSON.stringify(origin).includes('"role"'));
    }
  });
}

test('evidence depends on source values, paragraphs and quarter completeness, not saved run evidence', async () => {
  const csv = new CsvSource();
  const original = await evidencePack(csv, 1336917, '2015-12-31');
  const mutate: FactsSource = { async execute(q) {
    const result = await csv.execute(q);
    if (q.table === 'facts') result.rows = result.rows.map(r => r.concept === 'revenue' && r.fy_end === '2015-12-31' ? {...r,value: String(Number(r.value)*2)} : r);
    if (q.table === 'mdna_paragraphs') result.rows = [];
    return result;
  } };
  await assert.rejects(evidencePack(mutate,1336917,'2015-12-31'), /Missing filing data/);
  const numeric: FactsSource = { async execute(q) {
    const result = await csv.execute(q);
    if(q.table === 'facts') result.rows = result.rows.map(r => r.concept === 'revenue' && r.fy_end === '2015-12-31' ? {...r,value: String(Number(r.value)*2)} : r);
    if(q.table === 'mdna_paragraphs') result.rows = result.rows.map(r=>({...r,text: `${r.text} [source mutation]`}));
    return result;
  } };
  const changed = await evidencePack(numeric,1336917,'2015-12-31');
  assert.notDeepEqual(changed.evidence,original.evidence);
  assert(changed.evidence.some(e => e.text.includes('Quarterly revenue/receivables data is incomplete')));
  assert(changed.evidence.filter(e => e.kind === 'mdna').every(e=>e.text.endsWith('[source mutation]')));
  assert(changed.evidence.some(e => e.text.includes('$7,926.6M')));
});

test('paragraph export skips empty pieces, preserves gaps and follows Python universal newline reading', () => {
  assert.deepEqual(splitParagraphs('\r\n\r\n First \r\n\r\n \t\r\n\r\n Second \r\n\r\n'), [
    { para_no: '1', text: 'First' }, { para_no: '3', text: 'Second' },
  ]);
});

test('unknown concepts follow known concepts in CSV and equivalent SQL; unknown CIK is explicit', async () => {
  const rows = ['unknown','revenue','cfo'].map(concept => ({cik:'1',fy_end:'2020-12-31',concept}));
  assert.deepEqual(selectRows(rows, query('facts',1)).map(r=>r.concept), ['revenue','cfo','unknown']);
  await assert.rejects(evidencePack(new CsvSource(),9999999,'2020-01-01'), /Unknown CIK/);
});

test('Python formatting and multiline CSV preserve source text', () => {
  assert.equal(fixed(2.5,0),'2'); assert.equal(fixed(3.5,0),'4');
  assert.equal(fixed(2.55,1),'2.5'); assert.equal(fixed(-0.01,0),'-0');
  const rows = [{cik:'1',text:'He said "cash, revenue"\nthen continued.\r\nEnd'}];
  assert.deepEqual(parseCsv(toCsv(rows)),rows);
});
