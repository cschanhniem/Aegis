/**
 * Retry helper for judge adapters. Honours HTTP 429 + Retry-After,
 * exponential backoff on 5xx, and gives up cleanly so the runner can
 * mark the row as fallback if the provider is truly down.
 */

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 800;     // 0.8, 1.6, 3.2, 6.4, 12.8, 25.6 → ~50s ceiling
const MAX_DELAY_MS  = 30_000;

export interface RetryableFetchInit extends RequestInit {
  /** Max attempts (default 6). */
  attempts?: number;
}

/**
 * Like fetch() but retries on 429 / 5xx with backoff. Non-retryable
 * statuses (4xx other than 429) throw immediately.
 */
export async function retryingFetch(
  url: string,
  init: RetryableFetchInit,
): Promise<Response> {
  const attempts = init.attempts ?? MAX_ATTEMPTS;
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return res;

    // Retryable: 429, 5xx
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const delay = Math.max(retryAfter ?? 0, backoff(attempt));
      lastErr = new Error(`${url} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (attempt < attempts - 1) {
        await sleep(delay);
        continue;
      }
      throw lastErr;
    }

    // Non-retryable HTTP error: surface immediately so the user sees
    // 401 / 403 / bad-input bugs without burning retry budget.
    const body = await res.text();
    throw new Error(`${url} ${res.status}: ${body.slice(0, 200)}`);
  }

  throw lastErr instanceof Error ? lastErr : new Error(`retryingFetch: ${String(lastErr)}`);
}

function backoff(attempt: number): number {
  const ms = BASE_DELAY_MS * Math.pow(2, attempt);
  // Full jitter — flatten retry storms when concurrency > 1.
  return Math.min(MAX_DELAY_MS, ms) * (0.5 + Math.random() * 0.5);
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
