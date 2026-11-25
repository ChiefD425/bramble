import { describe, expect, it, vi } from "vitest";
import { ed25519Signer, fakeMailboxCrypto } from "../../test/mailbox-fakes";
import type { MailboxApi } from "./api";
import type { MailboxContext } from "./context";
import { LIMITS } from "./limits";
import { postSnapshot, requestSnapshot } from "./send";
import { freshState } from "./state";

const MAILBOX = "M".repeat(43);
const E = "e".repeat(22);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const gone = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

async function setup(now: { at: number }) {
	const me = await ed25519Signer();
	const base = fakeMailboxCrypto(MAILBOX, me);
	const sealed: Record<string, unknown>[] = [];
	const post = vi.fn(async () => ({ stored: true, recipients: 1 }));
	const ctx = {
		api: { mailboxId: MAILBOX, serverNow: () => now.at, post } as unknown as MailboxApi,
		crypto: {
			...base,
			mailboxSeal: async (group: string, aad: string, plaintext: string) => {
				sealed.push(JSON.parse(plaintext));
				return base.mailboxSeal(group, aad, plaintext);
			},
		},
		groupKeyB64: "G",
		sigKey: me.sigKey,
		now: () => now.at,
		random,
	} as unknown as MailboxContext;
	return { ctx, sealed, post, state: freshState(random) };
}

describe("answering and asking about a gap", () => {
	it("an answer carries this device's track for the sender it answers", async () => {
		const s = await setup({ at: 1000 });
		s.state.senders[gone] = { epoch: E, through: 4, above: [6] };
		await postSnapshot(
			s.ctx,
			s.state,
			{ entries: { entries: [], tombstones: [] }, roster: { devices: [], revoked: [] } },
			[gone],
			gone,
		);
		expect(s.sealed[0]).toMatchObject({ answers: gone, covers: { epoch: E, through: 4 } });
	});

	it("an uncovered gap is asked about again only after uncoveredRetryMs", async () => {
		const now = { at: 1000 };
		const s = await setup(now);
		s.state.uncovered[gone] = 1000;
		now.at = 1000 + LIMITS.requestEveryMs + 1;
		await requestSnapshot(s.ctx, s.state, gone);
		expect(s.post).not.toHaveBeenCalled();
		now.at = 1000 + LIMITS.uncoveredRetryMs + 1;
		await requestSnapshot(s.ctx, s.state, gone);
		expect(s.post).toHaveBeenCalledTimes(1);
	});
});
