import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DATA = resolve(ROOT, 'data/out');
export const GENERATED = resolve(ROOT, 'app/.generated');
export const SNAPSHOT = resolve(ROOT, 'app/fixtures/mdna');
export const RUNS = resolve(ROOT, 'runs');
