import { beforeAll, describe, expect, it } from "vitest";
import {
	base64ToBytes,
	base64UrlToBase64,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
} from "../util/bytes";
import { COSE_EDDSA, COSE_ES256 } from "../vault/passkey";
import { pkcs8FromKey, pkcs8FromScalar, pkcs8Pem } from "./passkey-key";
import { fakePasskeyImportPkcs8 } from "./test-crypto";

// The vault stores the bare 32-byte P-256 scalar (core-rust `secret.to_bytes()`), while CXF
// carries PKCS#8 DER. Getting that wrong is invisible in a round trip through our own code and
// only shows up as a counterparty refusing the passkey, so these tests check the DER against
// WebCrypto, which is the same parser a real importer uses.
let scalar = "";
let jwkX = "";

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	scalar = bytesToBase64(base64UrlToBytes(jwk.d ?? ""));
	jwkX = jwk.x ?? "";
});

describe("pkcs8FromScalar", () => {
	it("produces DER that WebCrypto will actually import", async () => {
		const der = pkcs8FromScalar(scalar);
		expect(der).not.toBeNull();
		const key = await crypto.subtle.importKey(
			"pkcs8",
			base64UrlToBytes(der ?? "") as BufferSource,
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign"],
		);
		// The curve point is recovered from the scalar, so the public half survives the trip
		// even though PKCS#8 here carries only the private scalar.
		const back = await crypto.subtle.exportKey("jwk", key);
		expect(back.x).toBe(jwkX);
	});

	it("is 67 bytes: a 35-byte header and the scalar", () => {
		expect(base64UrlToBytes(pkcs8FromScalar(scalar) ?? "")).toHaveLength(67);
	});

	it("refuses anything that isn't a 32-byte scalar, rather than emitting junk DER", () => {
		expect(pkcs8FromScalar(bytesToBase64(new Uint8Array(31)))).toBeNull();
		expect(pkcs8FromScalar(bytesToBase64(new Uint8Array(64)))).toBeNull();
		expect(pkcs8FromScalar("not base64 !!")).toBeNull();
	});
});

// The import direction is the Rust core's `passkey_import_pkcs8`, tested there (it signs with
// the converted key). What still needs proving here is that the DER we EXPORT survives that
// conversion, since a counterparty importing our passkey runs exactly this round trip.
describe("what we export survives a real import", () => {
	it("comes back as the SAME scalar the vault stores, not the DER blob", async () => {
		const der = pkcs8FromScalar(scalar);
		const material = await fakePasskeyImportPkcs8(base64UrlToBase64(der ?? ""));
		expect(material.privateKey).toBe(scalar);
		expect(base64ToBytes(material.privateKey)).toHaveLength(32);
	});

	it("yields a COSE_Key, since CXF carries no public key", async () => {
		const material = await fakePasskeyImportPkcs8(base64UrlToBase64(pkcs8FromScalar(scalar) ?? ""));
		const cose = base64ToBytes(material.publicKeyCose);
		expect([...cose.slice(0, 7)]).toEqual([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
		expect(cose).toHaveLength(77);
	});
});

describe("pkcs8FromKey", () => {
	// RFC 8410's v1 layout, the one KeePassXC writes: keepass-passkeys-real.kdbx, which KeePassXC
	// itself saved, opens with this same 16-byte header. This throwaway key is the one the KeePassXC
	// import tests use.
	const KEEPASSXC_ED25519 = "MC4CAQAwBQYDK2VwBCIEIOOO0h6TPWiDuKE/5iLREORnBCswBsTNmP6RRAqHpA6z";
	const seed = bytesToBase64(base64ToBytes(KEEPASSXC_ED25519).slice(16));

	it("wraps an Ed25519 seed byte for byte as KeePassXC stores the key", () => {
		expect(bytesToBase64(pkcs8FromKey(COSE_EDDSA, seed) ?? new Uint8Array())).toBe(
			KEEPASSXC_ED25519,
		);
	});

	it("gives an Ed25519 key WebCrypto reads back as the same seed", async () => {
		const der = pkcs8FromKey(COSE_EDDSA, seed) ?? new Uint8Array();
		const key = await crypto.subtle.importKey("pkcs8", der as BufferSource, "Ed25519", true, [
			"sign",
		]);
		const jwk = await crypto.subtle.exportKey("jwk", key);
		expect(bytesToBase64(base64UrlToBytes(jwk.d ?? ""))).toBe(seed);
	});

	it("wraps a P-256 scalar as the CXF export does", () => {
		const der = pkcs8FromKey(COSE_ES256, scalar) ?? new Uint8Array();
		expect(bytesToBase64Url(der)).toBe(pkcs8FromScalar(scalar));
	});

	it("refuses an algorithm it has no layout for, and a key of the wrong size", () => {
		expect(pkcs8FromKey(-257, scalar)).toBeNull();
		expect(pkcs8FromKey(COSE_EDDSA, bytesToBase64(new Uint8Array(31)))).toBeNull();
		expect(pkcs8FromKey(COSE_ES256, "not base64 !!")).toBeNull();
	});
});

describe("pkcs8Pem", () => {
	it("lays the key out as KeePassXC does: 64-character lines and a closing newline", () => {
		const b64 = "A".repeat(64) + "B".repeat(28);
		expect(pkcs8Pem(b64)).toBe(
			`-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n${"B".repeat(28)}\n-----END PRIVATE KEY-----\n`,
		);
	});
});
