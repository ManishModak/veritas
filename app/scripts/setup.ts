import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCsv, toCsv, type Row } from '../src/data/csv.ts';
import { DATA, GENERATED, SNAPSHOT } from '../src/paths.ts';

// Export the original blank-line paragraph split without changing the Python data outputs.
export async function prepareMdna(inputDir?: string): Promise<void> {
  const dir = inputDir ?? SNAPSHOT;
  const index = parseCsv(await readFile(join(dir, 'index.csv'), 'utf8'));
  const paragraphs: Row[] = [];
  for (const r of index) {
    const text = await readFile(join(dir, r.file), 'utf8');
    text.split('\n\n').forEach((p, i) => paragraphs.push({ cik: r.cik, period: r.period, para_no: String(i), text: p.trim(), url: r.url }));
  }
  await mkdir(GENERATED, { recursive: true });
  await writeFile(join(GENERATED, 'mdna_index.csv'), toCsv(index));
  await writeFile(join(GENERATED, 'mdna_paragraphs.csv'), toCsv(paragraphs));
  console.log(`Prepared ${index.length} MD&A filings and ${paragraphs.length} paragraphs (${dir === SNAPSHOT ? 'bundled SEC snapshot' : DATA}).`);
}

if (process.argv[1]?.endsWith('/setup.ts')) await prepareMdna(process.argv[2]);
