import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../src/paths.ts';

const outDir = '/run/media/manishm/T7_Shield/Projects/Hackathon/.agent/tasks/open-agent/static-demo/screenshots';
const port = 8792;
const cdpPort = 9522;
const baseUrl = `http://127.0.0.1:${port}/site/`;
const chromeProfile = `/tmp/veritas-chrome-profile-${Date.now()}`;

let serverProc: ChildProcess | null = null;
let chromeProc: ChildProcess | null = null;

async function cleanup() {
  if (chromeProc) {
    try { chromeProc.kill('SIGKILL'); } catch {}
    chromeProc = null;
  }
  if (serverProc) {
    try { serverProc.kill('SIGKILL'); } catch {}
    serverProc = null;
  }
  try { await rm(chromeProfile, { recursive: true, force: true }); } catch {}
}

process.on('SIGINT', async () => { await cleanup(); process.exit(1); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(1); });

async function waitForUrl(url: string, timeoutMs = 25000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await delay(100);
  }
  return false;
}

try {
  await mkdir(outDir, { recursive: true });

  console.log(`Starting python http.server on port ${port}...`);
  serverProc = spawn('python3', ['-m', 'http.server', String(port), '--directory', ROOT], { stdio: 'ignore' });

  const serverReady = await waitForUrl(`${baseUrl}api/cases.json`);
  if (!serverReady) throw new Error(`HTTP server did not become ready at ${baseUrl}`);
  console.log(`HTTP server is ready serving at ${baseUrl}`);

  console.log(`Starting headless Chrome on port ${cdpPort}...`);
  chromeProc = spawn('/usr/bin/google-chrome-stable', [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore' });

  const cdpReady = await waitForUrl(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!cdpReady) throw new Error(`Chrome CDP did not become ready at port ${cdpPort}`);
  console.log('Chrome CDP is ready');

  const tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const tab = tabs.find(t => t.type === 'page');
  if (!tab) throw new Error('No CDP page tab found');

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0;
  const consoleErrors: string[] = [];
  const networkFailures: { url: string; status?: number; errorText?: string }[] = [];

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data));
      if (data.id) {
        const p = pending.get(data.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(data.id);
          if (data.error) p.reject(new Error(JSON.stringify(data.error)));
          else p.resolve(data.result);
        }
      }
      if (data.method === 'Runtime.exceptionThrown') {
        const text = data.params.exceptionDetails.text + ': ' + (data.params.exceptionDetails.exception?.description ?? '');
        consoleErrors.push(text);
      }
      if (data.method === 'Network.responseReceived') {
        const res = data.params.response;
        // Status >= 400 is considered a network failure UNLESS it was an intentionally tested error
        if (res.status >= 400) {
          networkFailures.push({ url: res.url, status: res.status });
        }
      }
      if (data.method === 'Network.loadingFailed') {
        networkFailures.push({ url: data.params.blockedURL || data.params.requestId, errorText: data.params.errorText });
      }
    } catch (e) {
      console.error('Error handling WS message:', e);
    }
  };

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error('CDP connection failed: ' + String(e)));
    }),
    delay(5000).then(() => { throw new Error('CDP connect timeout'); })
  ]);

  async function send(method: string, params: unknown = {}) {
    const id = ++seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression: string) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description ?? ''));
    return result.result.value;
  }

  async function until(expression: string, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Timeout waiting for expression: ${expression}`);
  }

  async function shot(name: string) {
    await evaluate('document.fonts.ready');
    await delay(150);
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const targetFile = join(outDir, `${name}.png`);
    await writeFile(targetFile, Buffer.from(result.data, 'base64'));
    console.log(`[Screenshot] Saved ${name}.png -> ${targetFile}`);
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  console.log('\n--- Pass 1: Cohort and Reveal ---');
  await send('Page.navigate', { url: `${baseUrl}?t=${Date.now()}#/` });
  await until("document.querySelectorAll('#cohort-tbody tr[data-case-id]').length === 11");

  // Verify static banner and data-static="true"
  const isStaticAttr = await evaluate("document.documentElement.getAttribute('data-static') === 'true'");
  if (!isStaticAttr) throw new Error('HTML element is missing data-static="true"');
  const bannerText = await evaluate("document.querySelector('.static-notice')?.textContent");
  if (!bannerText?.includes('Static demo of recorded runs')) {
    throw new Error(`Static banner text missing or incorrect: ${bannerText}`);
  }
  console.log('Verified static notice banner under header.');

  await shot('cohort');

  // Reveal roles
  await evaluate("document.getElementById('btn-toggle-reveal').click()");
  await until("document.querySelector('#btn-toggle-reveal').getAttribute('aria-pressed') === 'true'");
  await shot('cohort-revealed');

  console.log('\n--- Pass 2: Deep Link Reload & Under Armour Case ---');
  await send('Page.navigate', { url: `${baseUrl}?t=${Date.now()}#/case/1336917_2015-12-31` });
  await until("document.getElementById('case-heading').textContent.includes('Under Armour') && document.querySelectorAll('.finding-card').length > 0");

  // Test Deep link reload
  await send('Page.reload');
  await until("document.getElementById('case-heading').textContent.includes('Under Armour') && document.querySelectorAll('.finding-card').length > 0");
  console.log('Deep link reload successfully loaded Under Armour case.');
  await shot('ua-fy2015-case');

  // Quarter chart
  await evaluate("document.querySelector('.quarter-section').scrollIntoView({ block: 'start' })");
  await until("document.querySelectorAll('.quarter-bar-column').length === 4");
  await shot('quarter-chart');

  // Evidence Drawer on E30
  console.log('Opening drawer on evidence E30...');
  await evaluate("document.querySelector('#view-case [data-eid=E30]').click()");
  await until("!document.getElementById('drawer-body').classList.contains('hidden')");
  const drawerE30Title = await evaluate("document.getElementById('drawer-evidence-id').textContent");
  if (drawerE30Title !== 'E30') throw new Error(`Expected drawer for E30, got ${drawerE30Title}`);
  await shot('drawer-e30');

  // Close drawer
  await evaluate("document.getElementById('drawer-close').click()");
  await until("document.getElementById('evidence-drawer').classList.contains('open') === false");

  // Memory section
  console.log('Scrolling to memory section...');
  await evaluate("document.querySelector('.memory-section').scrollIntoView({ block: 'start' })");
  await until("document.querySelectorAll('#memories-list .memory-item-card').length > 0");
  await shot('memory-section');

  // Test prior-case evidence from memory panel
  console.log('Testing prior-case evidence from memory panel...');
  await evaluate("document.querySelector('#memories-list [data-eid]').click()");
  await until("!document.getElementById('drawer-body').classList.contains('hidden')");
  const priorCompanyTitle = await evaluate("document.getElementById('drawer-title').textContent");
  if (!priorCompanyTitle.includes('MiMedx')) {
    throw new Error(`Expected prior case company in drawer title, got ${priorCompanyTitle}`);
  }
  console.log(`Prior case drawer opened successfully: "${priorCompanyTitle}".`);
  await evaluate("document.getElementById('drawer-close').click()");

  // Test blocked write: Feedback
  console.log('Testing blocked write (feedback button)...');
  await evaluate("document.querySelector('.btn-thumb[data-kind=helpful]').click()");
  await until("!document.getElementById('global-banner').classList.contains('hidden')");
  const feedbackBannerText = await evaluate("document.getElementById('banner-message').textContent");
  if (!feedbackBannerText.includes('This is the static demo. Run the app locally for live runs, feedback and search.')) {
    throw new Error(`Unexpected feedback banner text: ${feedbackBannerText}`);
  }
  console.log(`Blocked feedback correctly showed: "${feedbackBannerText}"`);
  await shot('blocked-write');

  // Test blocked memory custom search
  console.log('Testing blocked custom memory search...');
  await evaluate("document.getElementById('memory-query-input').value = 'receivables surge'");
  await evaluate("document.getElementById('btn-memory-query').click()");
  await until("document.getElementById('banner-message').textContent.includes('Memory search failed')");
  const memBannerText = await evaluate("document.getElementById('banner-message').textContent");
  console.log(`Blocked memory search correctly showed: "${memBannerText}"`);
  await evaluate("document.getElementById('btn-memory-reset').click()");

  // Test blocked Live Run (via direct API fetch call if button is disabled in sample mode)
  console.log('Testing blocked live run...');
  const liveRunResult = await evaluate(`
    fetch('/api/cases/1336917_2015-12-31/runs', { method: 'POST' })
      .then(async r => ({ status: r.status, data: await r.json() }))
  `) as { status: number; data: { error: string } };
  if (liveRunResult.status !== 400 || !liveRunResult.data?.error?.includes('This is the static demo.')) {
    throw new Error(`Unexpected live run response: ${JSON.stringify(liveRunResult)}`);
  }
  console.log(`Blocked live run correctly returned HTTP 400: "${liveRunResult.data.error}"`);

  console.log('\n--- Pass 3: Crawling all 11 cases and every evidence drawer ---');
  const casesData = await (await fetch(`${baseUrl}api/cases.json`)).json() as { cases: { id: string; company: string }[] };
  let totalDrawersOpened = 0;

  for (const [idx, c] of casesData.cases.entries()) {
    console.log(`[${idx + 1}/11] Crawling case ${c.id} (${c.company})...`);
    await evaluate(`location.hash = '#/case/${c.id}'`);
    await until(`document.getElementById('case-heading').textContent.includes('${c.company.replace(/'/g, "\\'")}') && document.querySelectorAll('.finding-card').length > 0`);

    // Find all evidence buttons on this case page
    const eids = await evaluate(`
      [...new Set([...document.querySelectorAll('#view-case [data-eid]')].map(el => el.getAttribute('data-eid')))]
    `) as string[];

    for (const eid of eids) {
      // Open drawer
      await evaluate(`document.querySelector('#view-case [data-eid="${eid}"]').click()`);
      await until("!document.getElementById('drawer-body').classList.contains('hidden') || !document.getElementById('drawer-error').classList.contains('hidden')");

      const hasError = await evaluate("!document.getElementById('drawer-error').classList.contains('hidden')");
      if (hasError) {
        const errText = await evaluate("document.getElementById('drawer-error').textContent");
        throw new Error(`Drawer error on case ${c.id} ${eid}: ${errText}`);
      }

      const displayedEid = await evaluate("document.getElementById('drawer-evidence-id').textContent");
      if (displayedEid !== eid) throw new Error(`Expected drawer for ${eid}, but found ${displayedEid}`);

      totalDrawersOpened++;
      await evaluate("document.getElementById('drawer-close').click()");
    }
  }

  // Filter out the intentional 400 test requests and browser favicon request
  const unexpectedNetworkFailures = networkFailures.filter(f => {
    if (f.url.includes('favicon.ico')) return false;
    if (f.status === 400) {
      if (f.url.includes('/api/feedback')) return false;
      if (f.url.includes('/runs')) return false;
      if (f.url.includes('/memory?q=')) return false;
    }
    return true;
  });

  console.log(`\nCrawl finished successfully!`);
  console.log(`- Cases crawled: ${casesData.cases.length}`);
  console.log(`- Evidence drawers opened and verified without error: ${totalDrawersOpened}`);
  console.log(`- Unexpected network failures: ${unexpectedNetworkFailures.length}`);
  console.log(`- Unhandled browser console errors: ${consoleErrors.length}`);

  if (unexpectedNetworkFailures.length > 0) {
    console.error('Failed network requests:', unexpectedNetworkFailures);
    throw new Error(`Found ${unexpectedNetworkFailures.length} unexpected network failures`);
  }
  if (consoleErrors.length > 0) {
    console.error('Console errors:', consoleErrors);
    throw new Error(`Found ${consoleErrors.length} unhandled browser exceptions`);
  }

  console.log('\nALL VERIFICATION PASSES PASSED WITH ZERO ERRORS!');
  ws.close();
} finally {
  await cleanup();
}
