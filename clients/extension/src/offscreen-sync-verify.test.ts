import {
	canonicalRosterEntry,
	decodeRoster,
	encodeRoster,
	type RosterEntry,
} from "@core/sync/roster";
import { describe, expect, it, vi } from "vitest";

// A stand-in verifier: a signature is `<key>|<message>`, and one key is malformed.
const { stub } = vi.hoisted(() => ({
	stub: {
		roster_verify: (key: string, message: string, sig: string) => {
			if (key === "malformed") throw new Error("not a key");
			return sig === `${key}|${message}`;
		},
	},
}));
vi.mock("./wasm-loader", () => ({ loadWasm: async () => stub }));

import { handleHostMessage } from "./offscreen-core";

const device = (id: string, sigKey?: string): RosterEntry => ({
	id,
	publicKey: `pk-${id}`,
	label: id,
	addedAt: 1,
	hlc: { wall: 1, counter: 0, node: id },
	...(sigKey ? { sigKey } : {}),
});
const signed = (e: RosterEntry): RosterEntry => ({
	...e,
	sig: `${e.sigKey}|${canonicalRosterEntry(e)}`,
});

describe("offscreen mailbox verification", () => {
	it("SYNC_SIG_VERIFY checks a roster signature", async () => {
		const verify = (publicB64: string, message: string, sigB64: string) =>
			handleHostMessage("SYNC_SIG_VERIFY", { publicB64, message, sigB64 });
		expect(await verify("K", "m", "K|m")).toEqual({ ok: true, data: true });
		expect(await verify("K", "other", "K|m")).toEqual({ ok: true, data: false });
		expect(await verify("malformed", "m", "x")).toEqual({ ok: true, data: false });
	});

	it("SYNC_ROSTER_VERIFY drops an entry whose signature fails", async () => {
		const local = { devices: [device("a")], revoked: [] };
		const forged = { ...signed(device("c", "KC")), sig: "forged" };
		const remote = { devices: [device("a"), signed(device("b", "KB")), forged], revoked: [] };
		const res = await handleHostMessage("SYNC_ROSTER_VERIFY", {
			rosterJson: encodeRoster(remote),
			localJson: encodeRoster(local),
		});
		expect(res.ok).toBe(true);
		const ids = decodeRoster(res.data as string).devices.map((d) => d.id);
		expect(ids.sort()).toEqual(["a", "b"]);
	});
});
