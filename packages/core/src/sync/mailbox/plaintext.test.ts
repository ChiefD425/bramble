import { describe, expect, it } from "vitest";
import { decodePlaintext, encodePlaintext, type MailboxPlaintext } from "./plaintext";

const body = {
	entries: { entries: [], tombstones: [] },
	roster: { devices: [], revoked: [] },
};
const delta: MailboxPlaintext = { v: 1, kind: "delta", epoch: "E".repeat(22), seq: 1, ...body };
const snapshot: MailboxPlaintext = {
	v: 1,
	kind: "snapshot",
	epoch: "E".repeat(22),
	seq: 0,
	part: 1,
	parts: 1,
	answers: null,
	...body,
};
const request: MailboxPlaintext = { v: 1, kind: "snapshot_request", of: null };

describe("mailbox plaintext", () => {
	it.each([delta, snapshot, request])("round-trips a $kind", (message) => {
		expect(decodePlaintext(encodePlaintext(message))).toEqual({ ok: true, message });
	});

	it("a newer version is unsupported, not malformed", () => {
		expect(decodePlaintext(JSON.stringify({ v: 2, kind: "delta" }))).toEqual({
			ok: false,
			why: "unsupported",
		});
	});

	it("an unknown kind is unsupported", () => {
		expect(decodePlaintext(JSON.stringify({ v: 1, kind: "blob_index" }))).toEqual({
			ok: false,
			why: "unsupported",
		});
	});

	it("a delta without an epoch is malformed", () => {
		const { epoch: _, ...broken } = delta as Extract<MailboxPlaintext, { kind: "delta" }>;
		expect(decodePlaintext(JSON.stringify(broken))).toEqual({ ok: false, why: "malformed" });
	});

	it("text that is not JSON is malformed", () => {
		expect(decodePlaintext("{not json")).toEqual({ ok: false, why: "malformed" });
	});
});
