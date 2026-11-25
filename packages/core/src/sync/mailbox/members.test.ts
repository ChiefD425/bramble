import { describe, expect, it, vi } from "vitest";
import { type MailboxApi, MailboxApiError } from "./api";
import type { MailboxContext } from "./context";
import { ensureAccount, ensureActive } from "./members";
import { freshState } from "./state";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));

describe("ensureActive", () => {
	it("falls back to activating when a concurrent create won", async () => {
		const activate = vi
			.fn()
			.mockRejectedValueOnce(new MailboxApiError(404, "not_found"))
			.mockResolvedValueOnce({ members: [] });
		const create = vi.fn().mockRejectedValueOnce(new MailboxApiError(409, "exists"));
		const ctx = { api: { activate, create } as unknown as MailboxApi, sigKey: KEY };
		const state = freshState(random);
		const roster = { devices: [], revoked: [] };
		expect(await ensureActive(ctx as unknown as MailboxContext, state, roster)).toBe("active");
		expect(activate).toHaveBeenCalledTimes(2);
		expect(create).toHaveBeenCalledWith({ members: [KEY] });
		expect(state).toMatchObject({ active: true, catchUp: true });
	});
});

describe("ensureAccount", () => {
	const A = "12345 67890 12345 67890 12345";
	const ctxWith = (attach: () => Promise<void>) =>
		({ api: { account: A, attach } as unknown as MailboxApi }) as unknown as MailboxContext;

	it("a full account leaves the mailbox where it is, and says so", async () => {
		const state = { ...freshState(random), active: true };
		const full = () => Promise.reject(new MailboxApiError(507, "quota_exceeded"));
		expect(await ensureAccount(ctxWith(full), state)).toBe("full");
		expect(state.account).toBeNull();
	});
});
