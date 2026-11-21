import { afterEach, describe, expect, it, vi } from "vitest";
import { BREACH_RECHECK_MS, checkPasswordBreach, isBreachCheckDue } from "./pwned";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("checkPasswordBreach", () => {
	it("gives up on a request that never answers, rather than holding the save", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const fetch = vi.fn(
			(_url: string, init?: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				),
		);
		vi.stubGlobal("fetch", fetch);
		const result = checkPasswordBreach("hunter2");
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		// The request starts after the hash, so wait for it before moving the clock.
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(10_000);
		expect(settled).toBe(true);
		await expect(result).resolves.toBeUndefined();
	});

	it("reports a leaked password from the range response", async () => {
		// SHA-1("password") = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\n")),
		);
		await expect(checkPasswordBreach("password")).resolves.toMatchObject({ leaked: true });
	});
});

describe("isBreachCheckDue", () => {
	const now = 10 * BREACH_RECHECK_MS;

	it("is due when never checked", () => {
		expect(isBreachCheckDue(undefined, now)).toBe(true);
	});

	it("holds a result for a week, then is due", () => {
		expect(isBreachCheckDue({ checkedAt: now - BREACH_RECHECK_MS }, now)).toBe(false);
		expect(isBreachCheckDue({ checkedAt: now - BREACH_RECHECK_MS - 1 }, now)).toBe(true);
	});

	// A result stamped by a clock that ran ahead would otherwise wait until the clock caught up.
	it("is due when the result is stamped in the future", () => {
		expect(isBreachCheckDue({ checkedAt: now + 1 }, now)).toBe(true);
	});
});
