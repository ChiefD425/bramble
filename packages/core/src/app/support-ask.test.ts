import { describe, expect, it } from "vitest";
import { normalizeSupportAskState, SUPPORT_URL, supportAskDue } from "./support-ask";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 23);

describe("supportAskDue", () => {
	it("never asks before the clock has started", () => {
		expect(supportAskDue({}, NOW)).toBe(false);
	});

	it("first asks two weeks after the clock starts", () => {
		expect(supportAskDue({ startedAt: NOW - 13 * DAY }, NOW)).toBe(false);
		expect(supportAskDue({ startedAt: NOW - 14 * DAY }, NOW)).toBe(true);
	});

	it("asks again two weeks after it was last shown", () => {
		const startedAt = NOW - 100 * DAY;
		expect(supportAskDue({ startedAt, askedAt: NOW - 13 * DAY }, NOW)).toBe(false);
		expect(supportAskDue({ startedAt, askedAt: NOW - 14 * DAY }, NOW)).toBe(true);
	});

	it("leaves someone who chose Donate for 90 days", () => {
		const startedAt = NOW - 365 * DAY;
		const asked = NOW - 30 * DAY;
		expect(supportAskDue({ startedAt, askedAt: asked, donatedAt: NOW - 89 * DAY }, NOW)).toBe(
			false,
		);
		expect(supportAskDue({ startedAt, askedAt: asked, donatedAt: NOW - 90 * DAY }, NOW)).toBe(true);
	});
});

describe("normalizeSupportAskState", () => {
	it("has no clock with nothing stored", () => {
		expect(normalizeSupportAskState(undefined, NOW)).toEqual({});
	});

	it("keeps good times and drops junk", () => {
		expect(
			normalizeSupportAskState({ startedAt: 5, askedAt: "soon", donatedAt: -1, extra: 1 }, NOW),
		).toEqual({ startedAt: 5, askedAt: undefined, donatedAt: undefined });
	});

	it("clamps a time from a clock that ran ahead, which would put the ask off for good", () => {
		expect(normalizeSupportAskState({ startedAt: NOW + 400 * DAY }, NOW).startedAt).toBe(NOW);
	});
});

describe("SUPPORT_URL", () => {
	it("is bramble.sh/donate everywhere but iOS, where App Review refuses an external tip link", () => {
		expect(SUPPORT_URL.ios).toBeUndefined();
		for (const target of ["chromium", "firefox", "desktop", "android"] as const)
			expect(SUPPORT_URL[target]).toBe("https://bramble.sh/donate");
	});
});
