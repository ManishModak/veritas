import { mkdir, readFile, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../src/paths.ts';
import { AppRuntime } from '../src/runtime.ts';
import { CsvSource } from '../src/data/source.ts';

// Calculate recursive directory size in bytes
export async function getDirectorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      const s = await stat(fullPath);
      total += s.size;
    }
  }
  return total;
}

// Prune provenance payload to drop unused entities and audit spam, keeping total static export under 25MB
export function pruneProvenance(prov: any, eid: string) {
  const audit = (prov.audit || [])
    .filter((a: any) => a.summary && a.summary.includes(eid))
    .map((a: any) => ({ seq: a.seq, actor: a.actor, summary: a.summary, kind: a.kind }));

  return {
    evidence: prov.evidence,
    origins: prov.origins,
    company: { attrs: prov.company?.attrs },
    filings: prov.filings?.map((f: any) => ({ attrs: f.attrs })),
    findings: prov.findings?.map((f: any) => ({ attrs: f.attrs })),
    rulings: prov.rulings?.map((r: any) => ({ attrs: r.attrs })),
    audit
  };
}

// Export static dataset and frontend assets for serverless GitHub Pages hosting
export async function exportStatic(outDir = join(ROOT, 'site')): Promise<{
  caseCount: number;
  evidenceCount: number;
  totalBytes: number;
}> {
  console.log('Booting in-process AppRuntime (sample mode, CSV facts)...');
  const runtime = await AppRuntime.create({ sampleMode: true, persist: false, source: new CsvSource() });

  await mkdir(outDir, { recursive: true });
  const apiDir = join(outDir, 'api');
  await mkdir(apiDir, { recursive: true });
  const casesDir = join(apiDir, 'cases');
  await mkdir(casesDir, { recursive: true });

  // 1. Cohort list (without and with roles)
  const cohort = runtime.list(false);
  await writeFile(join(apiDir, 'cases.json'), JSON.stringify(cohort));
  const cohortReveal = runtime.list(true);
  await writeFile(join(apiDir, 'cases-reveal.json'), JSON.stringify(cohortReveal));

  let totalEvidence = 0;

  // 2. Case detail, recall memory, and provenance for all evidence items
  for (const c of cohort.cases) {
    const detail = runtime.detail(c.id);
    await writeFile(join(casesDir, `${c.id}.json`), JSON.stringify(detail));

    const caseFolder = join(casesDir, c.id);
    const evidenceFolder = join(caseFolder, 'evidence');
    await mkdir(evidenceFolder, { recursive: true });

    const memory = runtime.recall(c.id);
    await writeFile(join(caseFolder, 'memory.json'), JSON.stringify(memory));

    for (const ev of detail.run.evidence) {
      const rawProv = runtime.provenance(c.id, ev.id);
      const prov = pruneProvenance(rawProv, ev.id);
      await writeFile(join(evidenceFolder, `${ev.id}.json`), JSON.stringify(prov));
      totalEvidence++;
    }
  }

  // 3. Copy frontend assets
  let indexHtml = await readFile(join(ROOT, 'app/ui/index.html'), 'utf8');
  indexHtml = indexHtml.replace('href="/style.css"', 'href="style.css"');
  if (!indexHtml.includes('rel="icon"')) {
    indexHtml = indexHtml.replace('</head>', '  <link rel="icon" href="data:,">\n</head>');
  }
  if (indexHtml.includes('<script src="/app.js"></script>')) {
    indexHtml = indexHtml.replace(
      '<script src="/app.js"></script>',
      '<script src="static.js"></script>\n  <script src="app.js"></script>'
    );
  } else if (indexHtml.includes('<script src="app.js"></script>')) {
    indexHtml = indexHtml.replace(
      '<script src="app.js"></script>',
      '<script src="static.js"></script>\n  <script src="app.js"></script>'
    );
  } else {
    indexHtml = indexHtml.replace('</body>', '  <script src="static.js"></script>\n  <script src="app.js"></script>\n</body>');
  }
  await writeFile(join(outDir, 'index.html'), indexHtml);

  await copyFile(join(ROOT, 'app/ui/app.js'), join(outDir, 'app.js'));
  await copyFile(join(ROOT, 'app/ui/style.css'), join(outDir, 'style.css'));
  await copyFile(join(ROOT, 'app/ui/static.js'), join(outDir, 'static.js'));

  const totalBytes = await getDirectorySize(outDir);
  const sizeMb = (totalBytes / (1024 * 1024)).toFixed(2);
  console.log(`Exported static demo to ${outDir}:`);
  console.log(`- ${cohort.cases.length} cases`);
  console.log(`- ${totalEvidence} evidence provenance files`);
  console.log(`- Total site size: ${sizeMb} MB (${totalBytes} bytes)`);

  return {
    caseCount: cohort.cases.length,
    evidenceCount: totalEvidence,
    totalBytes
  };
}

if (process.argv[1]?.endsWith('/export-static.ts')) {
  await exportStatic();
}
