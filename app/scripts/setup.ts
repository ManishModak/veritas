import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCsv, toCsv, type Row } from '../src/data/csv.ts';
import { DATA, GENERATED, SNAPSHOT } from '../src/paths.ts';

// Python read_text uses universal newlines; paragraph numbers retain gaps after empty pieces.
export function splitParagraphs(text: string): { para_no: string; text: string }[] {
  return text.replace(/\r\n?/g, '\n').split('\n\n').flatMap((p, i) => p.trim() ? [{ para_no: String(i), text: p.trim() }] : []);
}

// Export the original blank-line paragraph split without changing the Python data outputs.
export async function prepareMdna(inputDir?: string): Promise<void> {
  const dir = inputDir ?? SNAPSHOT;
  const index = parseCsv(await readFile(join(dir, 'index.csv'), 'utf8'));
  const paragraphs: Row[] = [];
  for (const r of index) {
    const text = await readFile(join(dir, r.file), 'utf8');
    for (const p of splitParagraphs(text)) paragraphs.push({ cik: r.cik, period: r.period, ...p, url: r.url });
  }
  await mkdir(GENERATED, { recursive: true });
  await writeFile(join(GENERATED, 'mdna_index.csv'), toCsv(index));
  await writeFile(join(GENERATED, 'mdna_paragraphs.csv'), toCsv(paragraphs));
  console.log(`Prepared ${index.length} MD&A filings and ${paragraphs.length} paragraphs (${dir === SNAPSHOT ? 'bundled SEC snapshot' : DATA}).`);
}

if (process.argv[1]?.endsWith('/setup.ts')) await prepareMdna(process.argv[2]);
