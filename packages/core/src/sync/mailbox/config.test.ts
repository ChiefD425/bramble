import { describe, expect, it } from "vitest";
import {
	HOSTED_MAILBOX_URL,
	MailboxStatusRecordSchema,
	mailboxServer,
	parseMailboxServer,
	readMailboxSettings,
} from "./config";

const HLC = { wall: 1, counter: 0, node: "n" };
const A = "12345 67890 12345 67890 12345";

describe("mailbox config", () => {
	it("accepts an origin and normalizes it", () => {
		expect(parseMailboxServer({ url: " https://Mail.Example/ " })).toEqual({
			ok: true,
			config: { kind: "custom", url: "https://mail.example" },
		});
	});

	it("refuses a path, a query or another scheme", () => {
		for (const url of ["https://m.example/sync", "https://m.example/?a=1", "ftp://m.example"]) {
			expect(parseMailboxServer({ url })).toEqual({ ok: false, field: "url" });
		}
	});

	it("drops an empty token and refuses a short one", () => {
		expect(parseMailboxServer({ url: "https://m.example", token: "" })).toEqual({
			ok: true,
			config: { kind: "custom", url: "https://m.example" },
		});
		expect(parseMailboxServer({ url: "https://m.example", token: "short" })).toEqual({
			ok: false,
			field: "token",
		});
	});

	it("the status record parses", () => {
		expect(MailboxStatusRecordSchema.parse({ status: "off", at: 1 })).toEqual({
			status: "off",
			at: 1,
		});
	});

	it("hosted points at Bramble's mailbox only while hosted is on", () => {
		const hosted = { config: { kind: "hosted" as const }, account: null };
		expect(mailboxServer(hosted, true)).toEqual({ url: HOSTED_MAILBOX_URL });
		expect(mailboxServer(hosted, false)).toBeNull();
		const token = "t".repeat(16);
		const custom = { kind: "custom" as const, url: "https://m.example", token };
		expect(mailboxServer({ config: custom, account: null }, false)).toEqual({
			url: "https://m.example",
			token,
		});
		expect(mailboxServer({ config: null, account: A }, true)).toBeNull();
	});

	it("reads the group's mailbox and its account number", () => {
		expect(
			readMailboxSettings({
				"pref.mailbox": { hlc: HLC, value: { kind: "hosted" } },
				"pref.mailboxAccount": { hlc: HLC, value: "1234567890-1234567890-12345" },
			}),
		).toEqual({ config: { kind: "hosted" }, account: A });
		expect(readMailboxSettings(undefined)).toEqual({ config: null, account: null });
	});

	it("a hosted server carries the account, a custom one never does", () => {
		expect(mailboxServer({ config: { kind: "hosted" }, account: A }, true)).toEqual({
			url: HOSTED_MAILBOX_URL,
			account: A,
		});
		expect(
			mailboxServer({ config: { kind: "custom", url: "https://m.example" }, account: A }, true),
		).toEqual({ url: "https://m.example" });
	});

	it("an unusable number reads as none", () => {
		for (const value of ["12345", 42, { number: A }]) {
			expect(
				readMailboxSettings({ "pref.mailboxAccount": { hlc: HLC, value } }).account,
			).toBeNull();
		}
	});

	it("a status record carries the account's figures, or that it is unknown", () => {
		const figures = { paidThrough: 2, frozen: false, usedBytes: 0, quotaBytes: 1, at: 1 };
		expect(
			MailboxStatusRecordSchema.parse({ status: "synced", at: 1, account: figures }).account,
		).toEqual(figures);
		expect(
			MailboxStatusRecordSchema.parse({
				status: "account_unknown",
				at: 1,
				account: { unknown: true, at: 1 },
			}).account,
		).toEqual({ unknown: true, at: 1 });
	});
});
