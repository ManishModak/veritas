import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppRuntime, HttpError } from '../src/runtime.ts';
import { CsvSource, COMPANY_TABLES } from '../src/data/source.ts';
import { parseCsv, toCsv } from '../src/data/csv.ts';
import { query } from '../src/data/queries.ts';
import { DATA, GENERATED } from '../src/paths.ts';

const CIK = 999999, FY = '2015-12-31', FILED = '2016-03-01';

// An "added company" folder as data/add_company.py writes it, built from Under Armour's FY2014-15 rows under a new CIK.
async function fixture(stateDir: string): Promise<string> {
  const dir = join(stateDir, 'companies', `${CIK}_${FY}`);
  await mkdir(dir, { recursive: true });
  for (const table of COMPANY_TABLES) {
    const rows = parseCsv(await readFile(join(table.startsWith('mdna_') ? GENERATED : DATA, `${table}.csv`), 'utf8'))
      .filter(r => r.cik === '1336917' && ['2014-12-31', FY].includes(r.fy_end ?? r.period) && (table !== 'beneish' || r.fy_end === FY) && (!table.startsWith('mdna_') || r.period === FY))
      .map(r => ({ ...r, cik: String(CIK), ...(r.company ? { company: 'Fixture Co' } : {}), ...(r.role !== undefined ? { role: '' } : {}), ...(table === 'mdna_index' ? { filed: FILED } : {}) }));
    await writeFile(join(dir, `${table}.csv`), toCsv(rows));
  }
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ id: `${CIK}_${FY}`, cik: CIK, company: 'Fixture Co', fy_end: FY }));
  return dir;
}

test('added rows replace base rows for the same company and date only', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'veritas-add-'));
  try {
    const dir = join(stateDir, 'ua'); await mkdir(dir);
    for (const table of COMPANY_TABLES) {
      const rows = parseCsv(await readFile(join(table.startsWith('mdna_') ? GENERATED : DATA, `${table}.csv`), 'utf8')).filter(r => r.cik === '1336917' && (r.fy_end ?? r.period) === FY);
      await writeFile(join(dir, `${table}.csv`), toCsv(table === 'facts' ? rows.map(r => r.concept === 'revenue' ? { ...r, value: '1' } : r) : rows));
    }
    const source = new CsvSource(), before = (await source.execute(query('facts', 1336917))).rows;
    await source.addCompany(dir);
    const after = (await source.execute(query('facts', 1336917))).rows;
    assert.equal(after.length, before.length);
    assert.equal(after.find(r => r.fy_end === FY && r.concept === 'revenue')!.value, '1');
    assert.deepEqual(after.filter(r => r.fy_end !== FY), before.filter(r => r.fy_end !== FY));
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('an added company-year is a case before its first run, survives restart and only recalls earlier filings', { timeout: 30000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'veritas-add-'));
  try {
    await fixture(stateDir);
    for (const round of [1, 2]) {
      const runtime = await AppRuntime.create({ source: new CsvSource(), sampleMode: true, stateDir });
      const id = `${CIK}_${FY}`, list = runtime.list();
      const added = list.cases.find(c => c.id === id)!;
      assert.equal(added.split, 'added', `round ${round}`);
      assert.equal(added.agreement, null);
      assert.equal(list.results.calls, 99, 'benchmark counts only recorded cases');
      const detail = runtime.detail(id);
      assert.equal(detail.run, null);
      assert.equal(detail.resultMode, 'none');
      assert(detail.evidenceCount > 20);
      assert.equal(detail.quarterComparison.length, 4);
      const e1 = runtime.provenance(id, 'E1') as any;
      assert.match(e1.origins.queries[0].sql, /FROM veritas_pg\.facts WHERE cik = 999999/);
      assert.equal(e1.filings[0].attrs.filed, FILED);
      assert(detail.memory.memories.length > 0);
      assert(detail.memory.memories.every(m => m.filed < FILED && m.caseId !== id));
      assert.throws(() => runtime.startRun(id), (e: unknown) => e instanceof HttpError && e.status === 503);
      runtime.shutdown();
    }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('company and year are validated before anything is fetched', async () => {
  const runtime = await AppRuntime.create({ source: new CsvSource(), sampleMode: true, persist: false });
  for (const [company, year] of [['NKE; rm -rf', 2020], ['--out', 2020], ['NKE', 2009], ['NKE', 2015.5]] as const)
    assert.throws(() => runtime.addCompany(company, year), (e: unknown) => e instanceof HttpError && e.status === 400);
  runtime.shutdown();
});
