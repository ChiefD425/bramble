import { describe, expect, it } from "vitest";
import type { EntryData } from "../../hooks/useVault";
import { modeList } from ".";

// The edit form saves the opened version with the form's fields laid over it, so a field the
// form leaves out is kept rather than cleared. Each mode must therefore name every field it owns,
// `undefined` when empty, or clearing that field in the form would quietly keep the old value.
// Fields no form owns: identity, bookkeeping, and the two lists EntryForm adds itself.
const NOT_OWNED = new Set([
	"id",
	"type",
	"createdAt",
	"updatedAt",
	"lastUsedAt",
	"archivedAt",
	"breach",
	"passwordChangelog",
	"partStamps",
	"itemStamps",
	"partStampsAt",
	"customFields",
	"tags",
]);

const FULL: Record<string, EntryData> = {
	login: {
		type: "login",
		name: "Bank",
		notes: "n",
		urls: ["https://bank.example"],
		username: "u",
		password: "p",
		totp: "JBSWY3DPEHPK3PXP",
		autofillEnabled: false,
		autoSubmit: true,
		subdomainMatch: "exact",
		passkeys: [
			{
				credentialId: "c",
				rpId: "bank.example",
				userName: "u",
				userHandle: "dXNlcg",
				alg: -7,
				publicKeyCose: "pk",
				privateKey: "sk",
				signCount: 0,
				createdAt: 0,
			},
		],
	},
	card: {
		type: "card",
		name: "Visa",
		notes: "n",
		cardholderName: "A B",
		number: "4111111111111111",
		brand: "visa",
		expMonth: "01",
		expYear: "30",
		cvv: "123",
	},
	note: { type: "note", name: "Note", notes: "n" },
	"ssh-key": {
		type: "ssh-key",
		name: "Deploy",
		notes: "n",
		publicKey: "ssh-ed25519 AAAA",
		privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
		passphrase: "pp",
		keyType: "ed25519",
	},
};

describe("every entry form names the fields it owns", () => {
	it("has a full fixture for every mode", () => {
		expect(Object.keys(FULL).sort()).toEqual(modeList.map((m) => m.type).sort());
	});

	for (const mode of modeList) {
		it(`${mode.type}: toEntry names every field of a full entry`, () => {
			const full = FULL[mode.type]!;
			const named = Object.keys(mode.toEntry(mode.toForm(full)));
			const owned = Object.keys(full).filter((k) => !NOT_OWNED.has(k));
			expect(owned.filter((k) => !named.includes(k))).toEqual([]);
		});
	}
});
