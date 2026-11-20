import type { HttpResponse } from "../adapters/http";

// A rate-limited call waits out Retry-After (seconds), or backs off 1s, 2s, 4s without one. A
// wait past the cap is left to the next scheduled run rather than holding this one open.
export const RATE_LIMIT_RETRIES = 3;
export const MAX_RETRY_WAIT_MS = 30_000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function retryDelayMs(res: HttpResponse, attempt: number): number {
	const seconds = Number(res.headers?.["retry-after"]);
	return seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
}
