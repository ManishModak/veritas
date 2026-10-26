import { setTimeout as delay } from 'node:timers/promises';

export const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
export type Ask = (system: string, user: string) => Promise<Record<string, unknown>>;

// Parse only the answer content. The provider's reasoning_content is never used as evidence.
export function parseAnswer(text: string): Record<string, unknown> {
  const starts: number[] = [];
  let quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"' && starts.length) quoted = true;
    else if (c === '{') starts.push(i);
    else if (c === '}' && starts.length) {
      const start = starts.pop()!;
      try {
        const parsed = JSON.parse(text.slice(start,i+1));
        if (['verdict','rebuttals','final_verdict'].some(k=>Object.hasOwn(parsed,k))) return parsed;
      } catch { /* Continue past non-JSON braces in surrounding commentary. */ }
    }
  }
  throw new Error('NIM answer contains invalid JSON or is missing the stage JSON object');
}

export interface NimOptions {
  apiKey?: string; endpoint?: string; fetch?: typeof fetch; timeoutMs?: number; attempts?: number;
  backoffMs?: number; signal?: AbortSignal; onRetry?: (attempt: number) => void;
}

// Retry transient HTTP/network failures with a bounded timeout; never include credentials or response bodies in errors.
export function nimClient(options: NimOptions = {}): Ask {
  const key = options.apiKey ?? process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('Live mode requires NVIDIA_API_KEY on the server');
  const transport = options.fetch ?? fetch, attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('NIM attempts must be between 1 and 5');
  return async (system, user) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      options.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await transport(options.endpoint ?? 'https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 16000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        });
      } catch {
        if (options.signal?.aborted) throw new Error('NIM run cancelled');
        if (attempt === attempts) throw new Error(`NIM ${timeout.aborted ? 'timeout' : 'network failure'} after ${attempts} attempts`);
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, { signal: options.signal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const transient = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!transient || attempt === attempts) throw new Error(`NIM HTTP ${response.status}${transient ? ` after ${attempts} attempts` : ''}`);
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, { signal: options.signal });
        continue;
      }
      let payload: any;
      try { payload = await response.json(); } catch {
        if (options.signal?.aborted) throw new Error('NIM run cancelled');
        if (!timeout.aborted) throw new Error('NIM returned a non-JSON response');
        if (attempt === attempts) throw new Error(`NIM timeout after ${attempts} attempts`);
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, {signal:options.signal});
        continue;
      }
      const choice = payload.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('NIM answer truncated at max_tokens; no result saved');
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new Error('NIM response has no answer content');
      try { return parseAnswer(content); } catch (error) {
        if (attempt === attempts) throw error;
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, {signal:options.signal});
      }
    }
    throw new Error('NIM attempts exhausted');
  };
}
