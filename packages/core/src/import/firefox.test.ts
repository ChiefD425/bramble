import { describe, expect, it } from "vitest";
import { parseGooglePasswords } from "./csv";
import { parseFirefox } from "./firefox";

// The shape Firefox writes (LoginExport.sys.mjs): every header and value quoted, a null cell left
// bare, CRLF between rows and none after the last.
const HEADER =
	'"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"';
const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n");

describe("parseFirefox", () => {
	it("maps each row to a login, with Firefox's dates", () => {
		const res = parseFirefox(
			csv(
				'"https://github.com","octo","pw""1",,"https://github.com","{1}","1700000000000","1700000500000","1700000100000"',
			),
		);
		expect(res.byType).toEqual({ login: 1 });
		expect(res.imported[0]).toEqual({
			type: "login",
			name: "github.com",
			urls: ["https://github.com"],
			username: "octo",
			password: 'pw"1',
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_100_000,
			lastUsedAt: 1_700_000_500_000,
		});
		expect(res.warnings).toEqual([]);
	});

	// Firefox exports its own Mozilla account sign-in too. Its "password" is the Sync key.
	it("leaves out Firefox's own account record, uncounted", () => {
		const res = parseFirefox(
			csv(
				'"chrome://FirefoxAccounts","0123abcd","{""version"":1,""accountData"":{""k"":""fake""}}","Firefox Accounts credentials",,"{2}","1","1","1"',
				'"https://example.com","me","pw",,"","{3}","1","1","1"',
			),
		);
		expect(res.imported.map((e) => e.name)).toEqual(["example.com"]);
		expect(res.skipped).toBe(0);
	});

	// A site's own sign-in dialog (HTTP authentication) and its form can both be saved.
	it("keeps an HTTP authentication login's realm", () => {
		const res = parseFirefox(
			csv('"https://router.lan","admin","pw","Router admin",,"{4}","1","1","1"'),
		);
		expect(res.imported[0]?.customFields).toEqual([{ key: "HTTP realm", value: "Router admin" }]);
	});

	it("names a login with no site after its username, and skips an empty row", () => {
		const res = parseFirefox(
			csv('"","me@example.com","pw",,"","{5}","","",""', '"","","",,"","{6}","","",""'),
		);
		expect(res.imported[0]).toMatchObject({ name: "me@example.com", urls: [] });
		expect(res.imported[0]).not.toHaveProperty("createdAt", expect.anything());
		expect(res.skipped).toBe(1);
	});

	it("names Google when its export is given to the Firefox card, and the other way round", () => {
		expect(() => parseFirefox("name,url,username,password,note\r\nA,https://a.com,u,p,")).toThrow(
			"This looks like an export from Google Password Manager.",
		);
		expect(() =>
			parseGooglePasswords(csv('"https://a.com","u","p",,"","{7}","1","1","1"')),
		).toThrow("This looks like an export from Firefox.");
	});
});
