import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseOnePassword } from "./onepassword";
import type { ImportAttachment } from "./types";

// data.1pif as 1Password writes it: one JSON record per line, each followed by this line.
const SEP = "***5642bee8-a5ff-11dc-8314-0800200c9a66***";
const pif = (...items: unknown[]) => items.map((i) => `${JSON.stringify(i)}\n${SEP}\n`).join("");

const BARE_WARNING =
	"Attachments aren't in data.1pif. To bring them too, zip the whole export folder and import the .zip instead.";

// Shapes from 1Password 7 for Mac: typeName + secureContents.
const macLogin = {
	uuid: "AAAA0000000000000000000000000001",
	typeName: "webforms.WebForm",
	title: "Example",
	location: "https://example.com/login",
	folderUuid: "F2",
	createdAt: 1_600_000_000,
	updatedAt: 1_600_000_100,
	openContents: { tags: ["work"] },
	secureContents: {
		notesPlain: "a note",
		URLs: [{ label: "", url: "https://example.com/login" }, { url: "https://example.org" }],
		fields: [
			{ name: "username", type: "T", value: "typed in a field" },
			{ name: "email", type: "E", value: "me@example.com", designation: "username" },
			{ name: "password", type: "P", value: "pw", designation: "password" },
			{ name: "remember", type: "C", value: "✓" },
			{ name: "go", type: "I", value: "" },
		],
		sections: [
			{
				title: "",
				fields: [
					{
						k: "concealed",
						n: "TOTP_0001",
						t: "one-time password",
						v: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
					},
					{ k: "string", n: "A1", t: "PIN hint", v: "the dog" },
					{ k: "concealed", n: "A2", t: "recovery", v: "r-123" },
					// 1Password leaves the value off an empty field.
					{ k: "string", n: "A3", t: "empty" },
				],
			},
			{ title: "Related Items", name: "linked items" },
		],
		passwordHistory: [{ value: "old", time: 1_500_000_000 }],
	},
};
const folders = [
	{ uuid: "F1", typeName: "system.folder.Regular", title: "Personal", secureContents: {} },
	{
		uuid: "F2",
		typeName: "system.folder.Regular",
		title: "Banking",
		folderUuid: "F1",
		secureContents: {},
	},
	{ uuid: "S1", typeName: "system.folder.SavedSearch", title: "Smart", secureContents: {} },
];

describe("parseOnePassword .1pif", () => {
	it("maps a Mac login: designated fields, every website, its code, folders as tags", () => {
		const res = parseOnePassword(pif(...folders, macLogin));
		expect(res.byType).toEqual({ login: 1 });
		expect(res.imported[0]).toEqual({
			type: "login",
			name: "Example",
			notes: "a note",
			tags: ["work", "Personal", "Banking"],
			createdAt: 1_600_000_000_000,
			updatedAt: 1_600_000_100_000,
			urls: ["https://example.com/login", "https://example.org"],
			username: "me@example.com",
			password: "pw",
			totp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
			// The undesignated form field is kept; the checkbox and button are form state.
			customFields: [
				{ key: "username", value: "typed in a field" },
				{ key: "PIN hint", value: "the dog" },
				{ key: "recovery", value: "r-123", hidden: true },
			],
		});
		expect(res.warnings).toEqual([
			"1 item(s) were in a 1Password folder, imported as tags.",
			BARE_WARNING,
		]);
	});

	// 1Password for Windows writes category + overview + details, and nests folders by `parent`.
	it("maps the Windows shape the same way", () => {
		const res = parseOnePassword(
			pif(
				{ uuid: "W1", typeName: "system.folder.Regular", overview: { title: "Top" } },
				{ uuid: "W2", typeName: "system.folder.Regular", parent: "W1", overview: { title: "Sub" } },
				{
					uuid: "W3",
					typeName: "system.folder.Regular",
					smart: true,
					overview: { title: "Smart" },
				},
				{
					uuid: "W4",
					category: "001",
					folder: "W2",
					hmac: "x",
					created: 1_544_000_000,
					updated: 1_553_000_000,
					overview: {
						title: "Google",
						url: "google.com",
						URLs: [{ l: "", u: "https://google.com" }, { u: "google.com" }],
						tags: ["mail"],
					},
					details: {
						fields: [
							{ type: "T", name: "username", value: "g", designation: "username" },
							{ type: "P", name: "password", value: "gp", designation: "password" },
						],
						notesPlain: "line1\r\nline2",
						sections: [
							{ fields: [{ k: "concealed", n: "TOTP_W", t: "otp", v: "JBSWY3DPEHPK3PXP" }] },
						],
					},
				},
			),
		);
		expect(res.imported[0]).toMatchObject({
			type: "login",
			name: "Google",
			notes: "line1\r\nline2",
			tags: ["mail", "Top", "Sub"],
			urls: ["https://google.com", "google.com"],
			username: "g",
			password: "gp",
			totp: "JBSWY3DPEHPK3PXP",
			createdAt: 1_544_000_000_000,
		});
		expect(res.imported[0]?.customFields).toBeUndefined();
	});

	it("maps a Password item to a login, in either shape", () => {
		const res = parseOnePassword(
			pif(
				{
					typeName: "passwords.Password",
					title: "Wi-Fi",
					secureContents: { password: "pw1", notesPlain: "n" },
				},
				{ category: "005", overview: { title: "Old" }, details: { password: "pw2" } },
			),
		);
		expect(
			res.imported.map(
				(e) => e.type === "login" && [e.name, e.username, e.password, e.customFields],
			),
		).toEqual([
			["Wi-Fi", "", "pw1", undefined],
			["Old", "", "pw2", undefined],
		]);
	});

	it("maps a card: number, holder, YYYYMM expiry, the rest as fields", () => {
		const res = parseOnePassword(
			pif({
				typeName: "wallet.financial.CreditCard",
				title: "Visa",
				secureContents: {
					// 1Password repeats section values as flat keys; the sections are what count.
					cvv: "999",
					sections: [
						{
							title: "",
							fields: [
								{ k: "string", n: "cardholder", t: "cardholder name", v: "A B" },
								{ k: "cctype", n: "type", t: "type", v: "visa" },
								{ k: "string", n: "ccnum", t: "number", v: "4111111111111111" },
								{ k: "concealed", n: "cvv", t: "verification number", v: "123" },
								{ k: "monthYear", n: "expiry", t: "expiry date", v: 202703 },
								{ k: "monthYear", n: "validFrom", t: "valid from", v: 202401 },
							],
						},
						{ title: "Contact", fields: [{ k: "concealed", n: "pin", t: "PIN", v: "1234" }] },
					],
				},
			}),
		);
		expect(res.imported[0]).toEqual({
			type: "card",
			name: "Visa",
			cardholderName: "A B",
			number: "4111111111111111",
			brand: "Visa",
			expMonth: "3",
			expYear: "2027",
			cvv: "123",
			customFields: [
				{ key: "valid from", value: "01/2024" },
				{ key: "PIN", value: "1234", hidden: true },
			],
		});
	});

	// Items not edited since 1Password 3 hold their values as flat keys, with no sections.
	it("reads an item in the old flat shape", () => {
		const res = parseOnePassword(
			pif(
				{
					typeName: "wallet.financial.CreditCard",
					title: "Old card",
					secureContents: {
						ccnum: "5555555555554444",
						cvv: "321",
						cardholder: "C D",
						expiry_mm: "12",
						expiry_yy: "2026",
						type: "mc",
						bank: "Big Bank",
					},
				},
				{
					typeName: "wallet.computer.Router",
					title: "Router",
					secureContents: { network_name: "home", wireless_password: "wifi", notesPlain: "n" },
				},
				{
					typeName: "webforms.WebForm",
					title: "Old login",
					location: "https://old.example",
					secureContents: {
						fields: [
							{ name: "Username", value: "u", designation: "username" },
							{ name: "Password", value: "p", designation: "password" },
						],
					},
				},
			),
		);
		expect(res.imported[0]).toMatchObject({
			type: "card",
			number: "5555555555554444",
			cvv: "321",
			cardholderName: "C D",
			expMonth: "12",
			expYear: "2026",
			customFields: [{ key: "bank", value: "Big Bank" }],
		});
		expect(res.imported[1]).toEqual({
			type: "note",
			name: "Router",
			notes: "n",
			customFields: [
				{ key: "network_name", value: "home" },
				{ key: "wireless_password", value: "wifi", hidden: true },
			],
		});
		expect(res.imported[2]).toMatchObject({
			username: "u",
			password: "p",
			urls: ["https://old.example"],
		});
	});

	it("keeps everything else as a note, with dates and addresses readable", () => {
		const res = parseOnePassword(
			pif({
				typeName: "wallet.onlineservices.Email.v2",
				title: "Mail",
				location: "https://mail.example",
				secureContents: {
					sections: [
						{
							title: "",
							fields: [
								{ k: "string", n: "pop_username", t: "username", v: "in" },
								{ k: "concealed", n: "pop_password", t: "password", v: "p1" },
								{ k: "date", n: "since", t: "since", v: 1_552_305_660 },
								{
									k: "address",
									n: "address",
									t: "address",
									v: { street: "1 Main St", city: "Berlin", zip: "10115", country: "de" },
								},
							],
						},
						{
							title: "SMTP",
							fields: [
								{ k: "string", n: "smtp_username", t: "username", v: "out" },
								{ k: "concealed", n: "smtp_password", t: "password", v: "p2" },
							],
						},
					],
				},
			}),
		);
		// A label that repeats takes its section's title, where it has one.
		expect(res.imported[0]).toEqual({
			type: "note",
			name: "Mail",
			customFields: [
				{ key: "username", value: "in" },
				{ key: "password", value: "p1", hidden: true },
				{ key: "since", value: "2019-03-11" },
				{ key: "address", value: "1 Main St, Berlin, 10115, de" },
				{ key: "SMTP: username", value: "out" },
				{ key: "SMTP: password", value: "p2", hidden: true },
				{ key: "URL", value: "https://mail.example" },
			],
		});
	});

	it("leaves trash, tombstones and saved searches behind", () => {
		const res = parseOnePassword(
			pif(
				{ typeName: "securenotes.SecureNote", title: "Kept", secureContents: { notesPlain: "x" } },
				{ typeName: "securenotes.SecureNote", title: "Binned", trashed: true, secureContents: {} },
				{ typeName: "system.Tombstone", title: "Gone", trashed: true },
				...folders,
			),
		);
		expect(res.imported.map((e) => e.name)).toEqual(["Kept"]);
		expect(res.skipped).toBe(0);
	});

	it("reads CRLF, a BOM, raw control characters, and bytes", () => {
		const text = `﻿${pif({
			typeName: "securenotes.SecureNote",
			title: "A",
			secureContents: { notesPlain: "x" },
		}).replace(
			/\n/g,
			"\r\n",
		)}{"typeName":"securenotes.SecureNote","title":"B","secureContents":{"notesPlain":"tab\there"}}\r\n${SEP}\r\n`;
		const res = parseOnePassword(strToU8(text));
		expect(res.imported.map((e) => [e.name, e.notes])).toEqual([
			["A", "x"],
			["B", "tab\there"],
		]);
	});

	// Bitwarden's reader was written against Windows exports with no separator lines.
	it("reads records one per line without separators", () => {
		const res = parseOnePassword(
			[
				JSON.stringify({
					category: "003",
					overview: { title: "One" },
					details: { notesPlain: "1" },
				}),
				JSON.stringify({
					category: "003",
					overview: { title: "Two" },
					details: { notesPlain: "2" },
				}),
			].join("\n"),
		);
		expect(res.imported.map((e) => e.name)).toEqual(["One", "Two"]);
	});

	it("counts a record it can't read, and refuses a file with none", () => {
		const res = parseOnePassword(
			`${pif({ typeName: "securenotes.SecureNote", title: "Fine", secureContents: {} })}{"title": broken\n${SEP}\n`,
		);
		expect(res.imported).toHaveLength(1);
		expect(res.skipped).toBe(1);
		expect(res.warnings).toContain("1 item(s) in this file couldn't be read.");

		expect(() => parseOnePassword("url,username,password\nhttps://a.com,u,p")).toThrow(
			"This doesn't look like a 1Password .1pux or .1pif export.",
		);
	});
});

describe("parseOnePassword zipped .1pif folder", () => {
	const text = async (a: ImportAttachment | undefined) =>
		a?.source.kind === "blob" ? await a.source.blob.text() : undefined;
	const note = (uuid: string, title: string) => ({
		uuid,
		typeName: "securenotes.SecureNote",
		title,
		secureContents: { notesPlain: "n" },
	});

	// Finder's Compress keeps the folder, and can add __MACOSX/ copies beside it.
	it("brings each item's attachments from beside data.1pif", async () => {
		const res = parseOnePassword(
			zipSync({
				"1Password Export.1pif/data.1pif": strToU8(pif(note("U1", "Deed"), note("U2", "Plain"))),
				"1Password Export.1pif/attachments/U1/deed.pdf": strToU8("pdf bytes"),
				"1Password Export.1pif/attachments/U1/.DS_Store": strToU8("junk"),
				"1Password Export.1pif/previews/U1/deed.png": strToU8("thumbnail"),
				"__MACOSX/1Password Export.1pif/._data.1pif": strToU8("resource fork"),
			}),
		);
		expect(res.imported.map((e) => e.name)).toEqual(["Deed", "Plain"]);
		expect(res.attachments?.map((a) => [a.entry, a.name, a.mime, a.size])).toEqual([
			[res.imported[0], "deed.pdf", "application/pdf", 9],
		]);
		expect(await text(res.attachments?.[0])).toBe("pdf bytes");
		expect(res.warnings).toEqual([]);
	});

	it("reads an Attachments folder whatever its case, at the top of the zip", () => {
		const res = parseOnePassword(
			zipSync({
				"data.1pif": strToU8(pif(note("U1", "Deed"))),
				"Attachments/U1/scan.png": strToU8("png"),
			}),
		);
		expect(res.attachments?.map((a) => a.name)).toEqual(["scan.png"]);
	});

	it("refuses a zip holding two exports rather than reading one", () => {
		const two = zipSync({
			"a.1pif/data.1pif": strToU8(pif(note("U1", "A"))),
			"b.1pif/data.1pif": strToU8(pif(note("U2", "B"))),
		});
		expect(() => parseOnePassword(two)).toThrow("more than one .1pif export");
	});

	it("names both formats when a zip holds neither", () => {
		expect(() => parseOnePassword(zipSync({ "other.txt": strToU8("nope") }))).toThrow(
			"This doesn't look like a 1Password .1pux or .1pif export.",
		);
	});
});
