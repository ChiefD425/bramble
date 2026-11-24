// The every-two-weeks donation card. See docs/support-ask.md.

import type { Target } from "../flags";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between asks, and after someone chose Donate. */
export const SUPPORT_ASK = { everyDays: 14, afterDonateDays: 90 };

const KOFI = "https://ko-fi.com/bramble_sh";

/** Where Donate goes, per target. Presence here IS the capability: iOS has none (App Review 3.1.1). */
export const SUPPORT_URL: Partial<Record<Target, string>> = {
	chromium: KOFI,
	firefox: KOFI,
	desktop: KOFI,
	android: KOFI,
};

export interface SupportAskState {
	/** When this device started the clock: its first vault list on a build that asks. */
	startedAt?: number;
	/** When the card was last shown. */
	askedAt?: number;
	/** When someone last chose Donate. */
	donatedAt?: number;
}

/** Field by field, like normalizeReviewNudgeState. A time in the future (a clock that was wrong)
 * is clamped to now, or it would put the next ask off indefinitely. */
export function normalizeSupportAskState(raw: unknown, now: number): SupportAskState {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const time = (v: unknown) => (typeof v === "number" && v > 0 ? Math.min(v, now) : undefined);
	return {
		startedAt: time(r.startedAt),
		askedAt: time(r.askedAt),
		donatedAt: time(r.donatedAt),
	};
}

export function supportAskDue(state: SupportAskState, now: number): boolean {
	if (state.startedAt === undefined) return false;
	const since = Math.max(state.startedAt, state.askedAt ?? 0);
	if (now - since < SUPPORT_ASK.everyDays * DAY_MS) return false;
	if (state.donatedAt !== undefined && now - state.donatedAt < SUPPORT_ASK.afterDonateDays * DAY_MS)
		return false;
	return true;
}
