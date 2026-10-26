import { resolve } from 'node:path';
import { CsvSource } from '../src/data/source.ts';
import { evidencePack } from '../src/agent/evidence.ts';
import { runCase, saveRun } from '../src/agent/run.ts';

const [cikText, fyEnd, samplesText = '1', output = 'app/.state/live-run.json'] = process.argv.slice(2);
const cik = Number(cikText);
if (!cikText || !fyEnd) throw new Error('Usage: npm run live -- CIK YYYY-MM-DD [samples=1] [output]');
const started = Date.now();
const run = await runCase(cik, fyEnd, await evidencePack(new CsvSource(),cik,fyEnd), {
  samples: Number(samplesText), progress: p => console.log(JSON.stringify(p)),
});
await saveRun(resolve(output),run);
console.log(JSON.stringify({saved:output,elapsedMs:Date.now()-started,agreement:run.agreement,grounding:run.samples.map(s=>s.grounding)}));
if (run.samples.some(s=>Object.values(s.grounding).some(g=>g.unknown_ids.length || g.uncited))) process.exitCode=1;
