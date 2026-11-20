// Bridging the PKCS#8 that CXF and KeePassXC carry against the bare 32-byte key the vault stores.
//
// Only the EXPORT direction lives here, and only because it is structural: wrapping a key
// in a fixed DER header parses nothing and does no curve maths. The IMPORT direction needs a
// real key parse plus a canonical COSE encoding, so it goes through the Rust core
// (`passkey_import_pkcs8`), which is the same code path that mints passkeys and therefore
// cannot drift from it. See docs/credential-exchange.md.

import { base64ToBytes, bytesToBase64Url } from "../util/bytes";
import { COSE_EDDSA, COSE_ES256 } from "../vault/passkey";

/** A P-256 scalar and an Ed25519 seed are both 32 bytes. */
const KEY_LEN = 32;

/**
 * PKCS#8 PrivateKeyInfo prefix for a P-256 key whose ECPrivateKey carries only the scalar
 * (RFC 5915 makes the public key OPTIONAL, and the curve is already named here):
 *
 *   SEQUENCE(65) { INTEGER 0,
 *                  SEQUENCE(19) { OID 1.2.840.10045.2.1, OID 1.2.840.10045.3.1.7 },
 *                  OCTET STRING(39) { SEQUENCE(37) { INTEGER 1, OCTET STRING(32) <scalar> } } }
 *
 * We store the bare 32-byte scalar (core-rust: `B64.encode(secret.to_bytes())`), while CXF's
 * `key` is PKCS#8 DER, so the two have to be bridged in both directions.
 */
const PKCS8_P256_PREFIX = new Uint8Array([
	0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
	0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
	0x01, 0x04, 0x20,
]);

/** RFC 8410's v1 PrivateKeyInfo for Ed25519, the layout KeePassXC writes:
 *
 *   SEQUENCE(46) { INTEGER 0, SEQUENCE(5) { OID 1.3.101.112 }, OCTET STRING(34) { OCTET STRING(32) <seed> } }
 */
const PKCS8_ED25519_PREFIX = new Uint8Array([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const PKCS8_PREFIX = new Map<number, Uint8Array>([
	[COSE_ES256, PKCS8_P256_PREFIX],
	[COSE_EDDSA, PKCS8_ED25519_PREFIX],
]);

/**
 * Our stored key (standard base64) as PKCS#8 DER for its COSE `alg`. Null for an algorithm with no
 * layout here or a key that isn't 32 bytes, so a damaged passkey is never written out as DER that
 * decodes fine and then signs for nothing.
 */
export function pkcs8FromKey(alg: number, keyB64: string): Uint8Array | null {
	const prefix = PKCS8_PREFIX.get(alg);
	if (!prefix) return null;
	let key: Uint8Array;
	try {
		key = base64ToBytes(keyB64);
	} catch {
		return null;
	}
	if (key.length !== KEY_LEN) return null;
	const der = new Uint8Array(prefix.length + KEY_LEN);
	der.set(prefix, 0);
	der.set(key, prefix.length);
	return der;
}

/**
 * Wrap our stored raw P-256 scalar (standard base64) as the base64url PKCS#8 that CXF wants.
 * Returns null unless the input really is a 32-byte scalar, so a malformed passkey is skipped
 * with a warning instead of exported as something no importer can use.
 */
export function pkcs8FromScalar(scalarB64: string): string | null {
	const der = pkcs8FromKey(COSE_ES256, scalarB64);
	return der && bytesToBase64Url(der);
}

/** PKCS#8 DER (standard base64) as PEM, laid out as KeePassXC writes it: 64-character lines and a
 * closing newline. */
export function pkcs8Pem(derB64: string): string {
	const lines = derB64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
