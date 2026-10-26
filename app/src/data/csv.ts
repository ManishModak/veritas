export type Row = Record<string, string>;

// Read RFC 4180-style CSV, including escaped quotes and multiline MD&A paragraphs.
export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { records.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed quoted CSV field');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); records.push(row); }
  const headers = records.shift() ?? [];
  return records.filter(r => r.some(Boolean)).map(r => {
    if (r.length !== headers.length) throw new Error('CSV column count mismatch');
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}

export function toCsv(rows: Row[], headers = Object.keys(rows[0] ?? {})): string {
  const quote = (s: string) => /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  return [headers, ...rows.map(r => headers.map(h => r[h] ?? ''))].map(r => r.map(quote).join(',')).join('\n') + '\n';
}
