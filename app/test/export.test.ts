import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/paths.ts';
import { AppRuntime } from '../src/runtime.ts';
import { CsvSource } from '../src/data/source.ts';
import { exportStatic, getDirectorySize } from '../scripts/export-static.ts';
import '../ui/static.js';

test('export writes a file for every case and evidence id, and shim maps api routes correctly', async () => {
  const siteDir = join(ROOT, 'site');

  // Run the static exporter
  const result = await exportStatic(siteDir);
  assert.equal(result.caseCount, 11);
  assert.equal(result.evidenceCount, 539);
  assert(result.totalBytes < 25 * 1024 * 1024, `Site size (${result.totalBytes} bytes) must be under 25 MB`);

  // Verify list endpoints
  assert(existsSync(join(siteDir, 'api/cases.json')), 'cases.json must exist');
  assert(existsSync(join(siteDir, 'api/cases-reveal.json')), 'cases-reveal.json must exist');

  // Verify UI assets
  assert(existsSync(join(siteDir, 'index.html')), 'site/index.html must exist');
  assert(existsSync(join(siteDir, 'app.js')), 'site/app.js must exist');
  assert(existsSync(join(siteDir, 'style.css')), 'site/style.css must exist');
  assert(existsSync(join(siteDir, 'static.js')), 'site/static.js must exist');

  const indexHtml = await readFile(join(siteDir, 'index.html'), 'utf8');
  assert(indexHtml.includes('<script src="static.js"></script>'), 'static.js must be loaded in site/index.html');
  assert(indexHtml.indexOf('static.js') < indexHtml.indexOf('app.js'), 'static.js must be loaded before app.js');
  assert(!indexHtml.includes('href="/style.css"'), 'style.css link must be relative');

  // Verify every case and every evidence id from runtime
  const runtime = await AppRuntime.create({ sampleMode: true, persist: false, source: new CsvSource() });
  const cohort = runtime.list(false);

  for (const c of cohort.cases) {
    const caseFile = join(siteDir, `api/cases/${c.id}.json`);
    assert(existsSync(caseFile), `Case file missing for ${c.id}`);
    const caseJson = JSON.parse(await readFile(caseFile, 'utf8'));
    assert.equal(caseJson.id, c.id);

    const memFile = join(siteDir, `api/cases/${c.id}/memory.json`);
    assert(existsSync(memFile), `Memory file missing for ${c.id}`);
    const memJson = JSON.parse(await readFile(memFile, 'utf8'));
    assert(Array.isArray(memJson.memories));

    const detail = runtime.detail(c.id);
    assert(detail.run, `Exported case ${c.id} has no recorded run`);
    for (const ev of detail.run.evidence) {
      const evFile = join(siteDir, `api/cases/${c.id}/evidence/${ev.id}.json`);
      assert(existsSync(evFile), `Evidence file missing for ${c.id} ${ev.id}`);
      const evJson = JSON.parse(await readFile(evFile, 'utf8'));
      assert.equal(evJson.evidence.id, ev.id);
      assert(evJson.origins.queries.length > 0);
      assert(evJson.origins.rows.length > 0);
      assert(evJson.filings.length > 0);
    }
  }

  // Verify fetch shim mapping
  const shim = (globalThis as any).VeritasStatic;
  assert(shim, 'VeritasStatic must be defined by static.js');
  const { mapApiUrl, STATIC_ERROR, installFetchShim } = shim;

  // 1. Evidence route mapping
  const mappedEv = mapApiUrl('/api/cases/1336917_2015-12-31/evidence/E30');
  assert.equal(mappedEv?.isBlocked, false);
  assert.equal(mappedEv?.relPath, 'api/cases/1336917_2015-12-31/evidence/E30.json');

  // 2. Cases reveal route mapping
  const mappedReveal = mapApiUrl('/api/cases?reveal=true');
  assert.equal(mappedReveal?.isBlocked, false);
  assert.equal(mappedReveal?.relPath, 'api/cases-reveal.json');

  // 3. Base cases route mapping
  const mappedCases = mapApiUrl('/api/cases');
  assert.equal(mappedCases?.isBlocked, false);
  assert.equal(mappedCases?.relPath, 'api/cases.json');

  // 4. Case detail mapping
  const mappedDetail = mapApiUrl('/api/cases/1336917_2015-12-31');
  assert.equal(mappedDetail?.isBlocked, false);
  assert.equal(mappedDetail?.relPath, 'api/cases/1336917_2015-12-31.json');

  // 5. Memory default mapping
  const mappedMem = mapApiUrl('/api/cases/1336917_2015-12-31/memory');
  assert.equal(mappedMem?.isBlocked, false);
  assert.equal(mappedMem?.relPath, 'api/cases/1336917_2015-12-31/memory.json');

  // 6. Custom memory query blocked
  const mappedMemCustom = mapApiUrl('/api/cases/1336917_2015-12-31/memory?q=receivables');
  assert.equal(mappedMemCustom?.isBlocked, true);
  assert.equal(mappedMemCustom?.error, STATIC_ERROR);

  // 7. Test fetch wrapping behavior on writes and blocked queries
  const fetchMockTarget: any = { fetch: async () => new Response('ok') };
  const wrappedFetch = installFetchShim(fetchMockTarget);
  assert(typeof wrappedFetch === 'function');

  // Blocked POST runs
  const postRunsRes = await wrappedFetch('/api/cases/1336917_2015-12-31/runs', { method: 'POST' });
  assert.equal(postRunsRes.status, 400);
  assert.deepEqual(await postRunsRes.json(), { error: STATIC_ERROR });

  // Blocked POST feedback
  const postFbRes = await wrappedFetch('/api/feedback', { method: 'POST', body: JSON.stringify({ memoryId: 'm1', kind: 'helpful' }) });
  assert.equal(postFbRes.status, 400);
  assert.deepEqual(await postFbRes.json(), { error: STATIC_ERROR });

  // Blocked custom search GET
  const searchRes = await wrappedFetch('/api/cases/1336917_2015-12-31/memory?q=revenue', { method: 'GET' });
  assert.equal(searchRes.status, 400);
  assert.deepEqual(await searchRes.json(), { error: STATIC_ERROR });
});
