import { beforeAll, describe, expect, it } from "vitest";
import { fakePasskeyImportPkcs8, testParserContext } from "../exchange/test-crypto";
import type { EntryData, PasskeyCredential } from "../hooks/useVault";
import { kdbxEntriesToResult } from "../import/kdbx";
import { pemToStandardBase64 } from "../import/passkey-fields";
import type { ImportParserContext } from "../import/types";
import type { FileRecord } from "../sync";
import { fileRecord } from "../test/vault-fixtures";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { toKdbxEntries, toKdbxExport, UnexportablePasskeyError } from "./kdbx";

/** For the entries here without a passkey, reaching the crypto bridge is itself a bug. */
const noPasskeys = {
	passkeyImportPkcs8: () => Promise.reject(new Error("no passkey expected in this test")),
};

/** Export then re-import through the real KDBX import path, which is what a user
 * moving a file between Bramble installs actually goes through. */
const roundTripAll = async (
	entries: EntryData[],
	context: ImportParserContext = noPasskeys,
): Promise<EntryData[]> => {
	const opened = { entries: toKdbxEntries(entries), attachments: [] };
	return (await kdbxEntriesToResult(opened, context)).imported;
};
const roundTrip = async (e: EntryData, context?: ImportParserContext): Promise<EntryData> => {
	const [back] = await roundTripAll([e], context);
	if (!back) throw new Error("nothing re-imported");
	return back;
};

const fields = (e: EntryData) => {
	const [out] = toKdbxEntries([e]);
	if (!out) throw new Error("no entry");
	return out.strings;
};
const value = (e: EntryData, key: string) => fields(e).find((s) => s.key === key)?.value;
const isProtected = (e: EntryData, key: string) => fields(e).find((s) => s.key === key)?.protected;

const login = (over: Partial<Extract<EntryData, { type: "login" }>> = {}): EntryData => ({
	type: "login",
	name: "GitHub",
	urls: ["https://github.com"],
	username: "octocat",
	password: "pw",
	...over,
});

describe("toKdbxEntries: logins", () => {
	it("maps the standard KeePass fields and protects only the password", async () => {
		const e = login({ notes: "a note" });
		expect(value(e, "Title")).toBe("GitHub");
		expect(value(e, "UserName")).toBe("octocat");
		expect(value(e, "Password")).toBe("pw");
		expect(value(e, "URL")).toBe("https://github.com");
		expect(value(e, "Notes")).toBe("a note");
		expect(isProtected(e, "Password")).toBe(true);
		expect(isProtected(e, "Title")).toBe(false);
	});

	it("keeps extra URLs as numbered fields rather than dropping them", async () => {
		// KeePass 2.x has one URL per entry; a multi-site credential must not lose the rest.
		const e = login({ urls: ["https://a.com", "https://b.com", "https://c.com"] });
		expect(value(e, "URL")).toBe("https://a.com");
		expect(value(e, "URL 2")).toBe("https://b.com");
		expect(value(e, "URL 3")).toBe("https://c.com");
	});

	it("writes an otpauth URI to `otp` and a bare secret to `TOTP Seed`", async () => {
		const uri = login({ totp: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP" });
		expect(value(uri, "otp")).toBe("otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP");
		expect(value(uri, "TOTP Seed")).toBeUndefined();

		const bare = login({ totp: "JBSWY3DPEHPK3PXP" });
		expect(value(bare, "TOTP Seed")).toBe("JBSWY3DPEHPK3PXP");
		expect(value(bare, "otp")).toBeUndefined();
		expect(isProtected(bare, "TOTP Seed")).toBe(true);
	});

	it("writes a Steam key in KeePassXC's encoder=steam form", async () => {
		const steam = login({ totp: "steam://JBSWY3DPEHPK3PXP" });
		expect(value(steam, "otp")).toBe(
			"otpauth://totp/Steam%3A?secret=JBSWY3DPEHPK3PXP&issuer=Steam&encoder=steam",
		);
		expect(value(steam, "TOTP Seed")).toBeUndefined();
		expect(isProtected(steam, "otp")).toBe(true);
	});

	it("omits fields with no value", async () => {
		const keys = fields(login({ urls: [] })).map((s) => s.key);
		expect(keys).not.toContain("URL");
		expect(keys).not.toContain("Notes");
	});
});

describe("toKdbxEntries: tags", () => {
	// Comma-joined into a single pair, which the Rust writer lifts into KeePass's own
	// <Tags> element so other clients read them as tags rather than a custom field.
	it("joins tags with commas, KeePass's own separator", async () => {
		expect(value(login({ tags: ["work", "bank"] }), "Tags")).toBe("work,bank");
	});

	it("leaves the pair off an untagged entry", async () => {
		expect(value(login(), "Tags")).toBeUndefined();
		expect(value(login({ tags: [] }), "Tags")).toBeUndefined();
	});

	it("is not protected: a tag is not a secret", async () => {
		expect(isProtected(login({ tags: ["work"] }), "Tags")).toBe(false);
	});

	it("round-trips back to tags rather than a custom field", async () => {
		const back = await roundTrip(login({ tags: ["work", "bank"] }));
		expect(back.tags).toEqual(["work", "bank"]);
		expect(back.customFields?.some((f) => f.key === "Tags")).toBeFalsy();
	});
});

describe("toKdbxEntries: archived entries", () => {
	// KeePass has no archived state and this writer emits a flat list, so the state rides
	// as a String field rather than a recycle-bin group. Exported, not dropped: a .kdbx is
	// a backup, and silently losing the archive would be worse than losing the label.
	it("writes an ISO date for an archived entry", async () => {
		expect(value(login({ archivedAt: Date.UTC(2026, 1, 3, 4, 5, 6) }), "Archived")).toBe(
			"2026-02-03T04:05:06.000Z",
		);
	});

	it("leaves the field off a live entry", async () => {
		expect(value(login(), "Archived")).toBeUndefined();
	});

	it("is not protected: it is a date, not a secret", async () => {
		expect(isProtected(login({ archivedAt: 1 }), "Archived")).toBe(false);
	});
});

/**
 * A real P-256 passkey, made with WebCrypto and converted as the core converts one, so the public
 * key a re-import derives from the written private key has to match the one stored here.
 */
const makePasskey = async (over: Partial<PasskeyCredential> = {}): Promise<PasskeyCredential> => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
	]);
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	const { privateKey, publicKeyCose } = await fakePasskeyImportPkcs8(bytesToBase64(pkcs8));
	return {
		// "++//AQ==": both characters base64url swaps, and padding it drops.
		credentialId: bytesToBase64(Uint8Array.of(0xfb, 0xef, 0xff, 0x01)),
		rpId: "github.com",
		rpName: "GitHub",
		userHandle: bytesToBase64(new TextEncoder().encode("octocat-id")),
		userName: "octocat",
		userDisplayName: "The Octocat",
		alg: -7,
		publicKeyCose,
		privateKey,
		signCount: 0,
		createdAt: Date.UTC(2026, 0, 2),
		lastUsedAt: Date.UTC(2026, 5, 6),
		prf: {
			credWithUV: bytesToBase64(new Uint8Array(32).fill(1)),
			credWithoutUV: bytesToBase64(new Uint8Array(32).fill(2)),
		},
		fido2Extensions: { credBlob: "AQ" },
		...over,
	};
};

describe("toKdbxEntries: passkeys", () => {
	let passkey: PasskeyCredential;
	beforeAll(async () => {
		passkey = await makePasskey();
	});
	const withPasskey = (...passkeys: PasskeyCredential[]) => login({ passkeys });

	// Exactly the attributes KeePassXC's BrowserService writes, so KeePassXC signs in with it.
	it("writes a passkey as KeePassXC's own attributes on its login", async () => {
		const e = withPasskey(passkey);
		expect(value(e, "Password")).toBe("pw");
		expect(value(e, "KPEX_PASSKEY_CREDENTIAL_ID")).toBe("--__AQ");
		expect(value(e, "KPEX_PASSKEY_USER_HANDLE")).toBe("b2N0b2NhdC1pZA");
		expect(value(e, "KPEX_PASSKEY_RELYING_PARTY")).toBe("github.com");
		expect(value(e, "KPEX_PASSKEY_USERNAME")).toBe("octocat");
		expect(value(e, "KPEX_PASSKEY_FLAG_BE")).toBe("1");
		expect(value(e, "KPEX_PASSKEY_FLAG_BS")).toBe("1");
		expect(value(e, "KPEX_PASSKEY_PRIVATE_KEY_PEM")).toMatch(
			/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/,
		);
	});

	it("protects what KeePassXC protects, and Bramble's own details", async () => {
		const e = withPasskey(passkey);
		for (const key of [
			"KPEX_PASSKEY_CREDENTIAL_ID",
			"KPEX_PASSKEY_PRIVATE_KEY_PEM",
			"KPEX_PASSKEY_USER_HANDLE",
			"KPEX_PASSKEY_BRAMBLE",
		]) {
			expect(isProtected(e, key), key).toBe(true);
		}
		expect(isProtected(e, "KPEX_PASSKEY_RELYING_PARTY")).toBe(false);
		expect(isProtected(e, "KPEX_PASSKEY_USERNAME")).toBe(false);
	});

	it("writes the stored private key, as the PKCS#8 KeePassXC loads", async () => {
		const pem = value(withPasskey(passkey), "KPEX_PASSKEY_PRIVATE_KEY_PEM") ?? "";
		const back = await fakePasskeyImportPkcs8(pemToStandardBase64(pem));
		expect(back.privateKey).toBe(passkey.privateKey);
		expect(back.publicKeyCose).toBe(passkey.publicKeyCose);
	});

	it("writes an Ed25519 key in KeePassXC's own layout", async () => {
		// The seed of the throwaway key the KeePassXC import tests use.
		const pem = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOOO0h6TPWiDuKE/5iLREORnBCswBsTNmP6RRAqHpA6z
-----END PRIVATE KEY-----
`;
		const seed = bytesToBase64(base64ToBytes(pemToStandardBase64(pem)).slice(16));
		const e = withPasskey({ ...passkey, alg: -8, privateKey: seed });
		expect(value(e, "KPEX_PASSKEY_PRIVATE_KEY_PEM")).toBe(pem);
	});

	// KeePassXC keeps one passkey per entry, so a second one needs an entry of its own. Appended
	// after every vault entry, so the n-th entry written is still the n-th entry given.
	it("gives each further passkey an entry of its own, after every vault entry", async () => {
		const second = await makePasskey({
			credentialId: bytesToBase64(Uint8Array.of(9, 9, 9)),
			userName: "octocat-work",
		});
		const card: EntryData = {
			type: "card",
			name: "Personal Visa",
			cardholderName: "Jane Q. Doe",
			number: "4111111111111111",
			expMonth: "8",
			expYear: "2027",
			cvv: "123",
		};
		const out = toKdbxEntries([withPasskey(passkey, second), card]);
		const get = (i: number, key: string) => out[i]?.strings.find((s) => s.key === key)?.value;
		expect(out).toHaveLength(3);
		expect(get(0, "KPEX_PASSKEY_CREDENTIAL_ID")).toBe("--__AQ");
		expect(get(1, "Title")).toBe("Personal Visa");
		expect(get(2, "Title")).toBe("GitHub");
		expect(get(2, "UserName")).toBe("octocat-work");
		expect(get(2, "URL")).toBe("https://github.com");
		expect(get(2, "KPEX_PASSKEY_CREDENTIAL_ID")).toBe("CQkJ");
		// The login's password stays on the login; a passkey's entry holds the passkey alone.
		expect(get(2, "Password")).toBeUndefined();
	});

	it("refuses a passkey whose key it can't write, naming its entry", async () => {
		const e = withPasskey({ ...passkey, privateKey: bytesToBase64(new Uint8Array(3)) });
		expect(() => toKdbxEntries([e])).toThrow(UnexportablePasskeyError);
		expect(() => toKdbxEntries([e])).toThrow(/GitHub/);
	});

	it("brings a passkey back into Bramble exactly as it was", async () => {
		const back = await roundTrip(withPasskey(passkey), testParserContext);
		expect(back.type === "login" && back.passkeys).toEqual([passkey]);
		expect(back.customFields?.some((f) => f.key.startsWith("KPEX_"))).toBeFalsy();
	});

	it("brings a further passkey back as a login of its own", async () => {
		const second = await makePasskey({ credentialId: bytesToBase64(Uint8Array.of(9, 9, 9)) });
		const [first, own] = await roundTripAll([withPasskey(passkey, second)], testParserContext);
		expect(first?.type === "login" && first.passkeys).toEqual([passkey]);
		expect(own?.type === "login" && own.passkeys).toEqual([second]);
	});
});

describe("toKdbxEntries: non-login types", () => {
	it("writes card fields, protecting the number and CVV", async () => {
		const e: EntryData = {
			type: "card",
			name: "Personal Visa",
			cardholderName: "Jane Q. Doe",
			number: "4111111111111111",
			brand: "Visa",
			expMonth: "8",
			expYear: "2027",
			cvv: "123",
		};
		expect(value(e, "Title")).toBe("Personal Visa");
		expect(value(e, "Cardholder Name")).toBe("Jane Q. Doe");
		expect(value(e, "Number")).toBe("4111111111111111");
		expect(isProtected(e, "Number")).toBe(true);
		expect(isProtected(e, "CVV")).toBe(true);
		expect(isProtected(e, "Brand")).toBe(false);
	});

	it("writes SSH key fields, protecting the private key and passphrase", async () => {
		const e: EntryData = {
			type: "ssh-key",
			name: "Deploy key",
			publicKey: "ssh-ed25519 AAAA",
			privateKey: "-----BEGIN-----",
			passphrase: "secret",
			keyType: "ed25519",
		};
		expect(value(e, "Public Key")).toBe("ssh-ed25519 AAAA");
		expect(isProtected(e, "Private Key")).toBe(true);
		expect(isProtected(e, "Passphrase")).toBe(true);
		expect(isProtected(e, "Public Key")).toBe(false);
	});

	it("reduces a note to Title plus Notes", async () => {
		const e: EntryData = { type: "note", name: "Wi-Fi", notes: "SSID: Nimbus" };
		expect(fields(e).map((s) => s.key)).toEqual(["Title", "Notes"]);
	});
});

describe("toKdbxEntries: custom fields", () => {
	it("carries custom fields and maps hidden to protected", async () => {
		const e = login({
			customFields: [
				{ key: "Recovery email", value: "backup@example.com" },
				{ key: "PAT", value: "ghp_x", hidden: true },
			],
		});
		expect(value(e, "Recovery email")).toBe("backup@example.com");
		expect(isProtected(e, "PAT")).toBe(true);
		expect(isProtected(e, "Recovery email")).toBe(false);
	});

	it("suffixes a custom field that would shadow a standard KeePass key", async () => {
		// Two <String>s sharing a <Key> is malformed, and dropping the value is worse.
		const e = login({ customFields: [{ key: "Password", value: "not-the-real-one" }] });
		expect(value(e, "Password")).toBe("pw");
		expect(value(e, "Password (2)")).toBe("not-the-real-one");
		expect(fields(e).filter((s) => s.key === "Password")).toHaveLength(1);
	});

	it("keeps two identically-named custom fields distinct", async () => {
		const e = login({
			customFields: [
				{ key: "Note", value: "first" },
				{ key: "Note", value: "second" },
			],
		});
		expect(value(e, "Note")).toBe("first");
		expect(value(e, "Note (2)")).toBe("second");
	});
});

describe("export/import agree", () => {
	it("round-trips a login through the KeePass field mapper", async () => {
		const original = login({
			name: "GitHub",
			username: "octocat@example.com",
			password: "hunter2",
			urls: ["https://github.com"],
			notes: "Personal dev account.",
			totp: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
			customFields: [{ key: "Recovery email", value: "backup@example.com" }],
		});

		const back = await roundTrip(original);

		expect(back).toMatchObject({
			type: "login",
			name: "GitHub",
			username: "octocat@example.com",
			password: "hunter2",
			urls: ["https://github.com"],
			notes: "Personal dev account.",
			totp: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
		});
		expect(back.customFields).toEqual([{ key: "Recovery email", value: "backup@example.com" }]);
	});

	it("re-imports a card as a login carrying its fields (KeePass has no card type)", async () => {
		const card: EntryData = {
			type: "card",
			name: "Personal Visa",
			cardholderName: "Jane Q. Doe",
			number: "4111111111111111",
			expMonth: "8",
			expYear: "2027",
			cvv: "123",
		};

		const back = await roundTrip(card);

		expect(back.type).toBe("login");
		expect(back.name).toBe("Personal Visa");
		expect(back.customFields).toEqual(
			expect.arrayContaining([
				{ key: "Number", value: "4111111111111111", hidden: true },
				{ key: "CVV", value: "123", hidden: true },
			]),
		);
	});
});

describe("toKdbxExport", () => {
	const login = (id: string, name: string): EntryData & { id: string } => ({
		id,
		type: "login",
		name,
		urls: [],
		username: "u",
		password: "p",
	});
	/** Each record's sealed name, by id; "scan.pdf" for any not listed. */
	const named =
		(names: Record<string, string> = {}) =>
		async (record: FileRecord) => ({ name: names[record.id] ?? "scan.pdf", mime: "x/y" });

	it("puts each attachment on its own entry's index", async () => {
		const out = await toKdbxExport(
			[login("e1", "Passport"), login("e2", "Deed")],
			[fileRecord({ id: "f1", entryId: "e2" }), fileRecord({ id: "f2", entryId: "e1" })],
			"Attachments",
			named(),
		);
		expect(out.entries).toHaveLength(2);
		expect(out.files.map((f) => [f.record.id, f.entry])).toEqual([
			["f1", 1],
			["f2", 0],
		]);
	});

	// A file whose entry was deleted elsewhere is still the user's file: exported, not dropped.
	it("gathers attachments with no entry onto one extra entry", async () => {
		const out = await toKdbxExport(
			[login("e1", "Passport")],
			[
				fileRecord({ id: "f1", entryId: "gone" }),
				fileRecord({ id: "f2" }),
				fileRecord({ id: "f3", entryId: "e1" }),
			],
			"Attachments",
			named({ f1: "a.pdf", f2: "b.pdf" }),
		);
		expect(out.entries).toHaveLength(2);
		expect(out.entries[1]?.strings).toEqual([
			{ key: "Title", value: "Attachments", protected: false },
		]);
		expect(out.files.map((f) => f.entry)).toEqual([1, 1, 0]);
	});

	it("keeps attachments on their entries when passkeys add entries", async () => {
		const passkey = await makePasskey();
		const second = await makePasskey({ credentialId: bytesToBase64(Uint8Array.of(9, 9, 9)) });
		const github: EntryData & { id: string } = {
			id: "e1",
			type: "login",
			name: "GitHub",
			urls: [],
			username: "u",
			password: "p",
			passkeys: [passkey, second],
		};
		const out = await toKdbxExport(
			[github, login("e2", "Deed")],
			[fileRecord({ id: "f1", entryId: "e2" }), fileRecord({ id: "f2", entryId: "gone" })],
			"Attachments",
			named(),
		);
		expect(out.entries.map((e) => e.strings.find((s) => s.key === "Title")?.value)).toEqual([
			"GitHub",
			"Deed",
			"GitHub",
			"Attachments",
		]);
		expect(out.files.map((f) => f.entry)).toEqual([1, 3]);
	});

	it("adds no extra entry when every attachment has one", async () => {
		const out = await toKdbxExport(
			[login("e1", "A")],
			[fileRecord({ entryId: "e1" })],
			"Attachments",
			named(),
		);
		expect(out.entries).toHaveLength(1);
	});

	// KeePass keys an entry's attachments by name, so two of one name on one entry would collide.
	it("names each attachment as sealed, made unique on its entry only", async () => {
		const out = await toKdbxExport(
			[login("e1", "A"), login("e2", "B")],
			[
				fileRecord({ id: "f1", entryId: "e1" }),
				fileRecord({ id: "f2", entryId: "e1" }),
				fileRecord({ id: "f3", entryId: "e1" }),
				fileRecord({ id: "f4", entryId: "e2" }),
				fileRecord({ id: "f5", entryId: "e1" }),
			],
			"Attachments",
			named({ f5: "README" }),
		);
		expect(out.files.map((f) => f.name)).toEqual([
			"scan.pdf",
			"scan (2).pdf",
			"scan (3).pdf",
			"scan.pdf",
			"README",
		]);
	});
});
