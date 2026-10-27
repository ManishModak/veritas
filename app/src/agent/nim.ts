import { setTimeout as delay } from 'node:timers/promises';

export const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
export type Ask = (system: string, user: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;

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
  backoffMs?: number; signal?: AbortSignal; onRetry?: (attempt: number) => void; onResponse?: (call: Call) => void;
  env?: Record<string, string | undefined>;
}
// One answered model request: which provider served it, which model actually handled it, and how long it took.
export interface Call { provider: Provider['name']; model: string; ms: number; status: 'ok' | 'invalid_answer'; receipt?: string }

export interface Provider { name: 'meterless-nightshift' | 'nvidia-nim'; label: string; endpoint: string; token?: string; model: string; headers: Record<string, string> }

// Meterless Nightshift is the primary provider whenever METERLESS_BASE_URL is set; direct NVIDIA NIM is the fallback.
export function provider(env: Record<string, string | undefined> = process.env): Provider {
  const base = env.METERLESS_BASE_URL?.trim().replace(/\/+$/, '');
  if (base) return { name: 'meterless-nightshift', label: 'Nightshift', endpoint: `${base}/chat/completions`, token: env.METERLESS_RUNTIME_TOKEN,
    model: env.METERLESS_MODEL?.trim() || MODEL, headers: { 'meterless-app': 'veritas', 'meterless-scope': 'user' } };
  return { name: 'nvidia-nim', label: 'NIM', endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', token: env.NVIDIA_API_KEY, model: MODEL, headers: {} };
}

// Nightshift returns the model's reasoning inline, closed by </think>; only the text after it is the answer.
export function answerText(content: string): string {
  const end = content.lastIndexOf('</think>');
  return end < 0 ? content : content.slice(end + '</think>'.length);
}

// Retry transient HTTP/network failures with a bounded timeout; never include credentials or response bodies in errors.
export function nimClient(options: NimOptions = {}): Ask {
  const via = provider(options.env), key = options.apiKey ?? via.token, label = via.label;
  if (!key) throw new Error(via.name === 'meterless-nightshift' ? 'Live mode requires METERLESS_RUNTIME_TOKEN (Nightshift Console API key) on the server' : 'Live mode requires METERLESS_BASE_URL + METERLESS_RUNTIME_TOKEN (Nightshift) or NVIDIA_API_KEY on the server');
  const transport = options.fetch ?? fetch, attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('NIM attempts must be between 1 and 5');
  return async (system, user, callSignal?: AbortSignal) => {
    const effectiveSignal = callSignal && options.signal ? (callSignal === options.signal ? callSignal : AbortSignal.any([options.signal, callSignal])) : (callSignal ?? options.signal);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      effectiveSignal?.throwIfAborted();
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
      const signal = effectiveSignal ? AbortSignal.any([effectiveSignal, timeout]) : timeout;
      let response: Response;
      const started = Date.now();
      try {
        response = await transport(options.endpoint ?? via.endpoint, {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...via.headers },
          body: JSON.stringify({ model: via.model, temperature: 0.3, max_tokens: 16000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        });
      } catch {
        if (effectiveSignal?.aborted) throw new Error(`${label} run cancelled`);
        if (attempt === attempts) throw new Error(`${label} ${timeout.aborted ? 'timeout' : 'network failure'} after ${attempts} attempts`);
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, { signal: effectiveSignal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const transient = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!transient || attempt === attempts) throw new Error(`${label} HTTP ${response.status}${transient ? ` after ${attempts} attempts` : ''}`);
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, { signal: effectiveSignal });
        continue;
      }
      let payload: any;
      try { payload = await response.json(); } catch {
        if (effectiveSignal?.aborted) throw new Error(`${label} run cancelled`);
        if (!timeout.aborted) throw new Error(`${label} returned a non-JSON response`);
        if (attempt === attempts) throw new Error(`${label} timeout after ${attempts} attempts`);
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, { signal: effectiveSignal });
        continue;
      }
      const choice = payload.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error(`${label} answer truncated at max_tokens; no result saved`);
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new Error(`${label} response has no answer content`);
      // Every answered request is recorded, including answers rejected below and retried.
      const call = { provider: via.name, model: String(payload.meterless?.routed_model ?? payload.model ?? via.model), ms: Date.now() - started, ...(payload.meterless?.receipt_id ? { receipt: String(payload.meterless.receipt_id) } : {}) };
      try {
        const answer = parseAnswer(answerText(content));
        options.onResponse?.({ ...call, status: 'ok' });
        return answer;
      } catch (error) {
        options.onResponse?.({ ...call, status: 'invalid_answer' });
        if (attempt === attempts) throw error;
        options.onRetry?.(attempt);
        await delay((options.backoffMs ?? 1000) * 2 ** (attempt - 1), undefined, { signal: effectiveSignal });
      }
    }
    throw new Error(`${label} attempts exhausted`);
  };
}
