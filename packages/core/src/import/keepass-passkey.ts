// KeePassXC stores a passkey as ordinary entry attributes on its login, named KPEX_PASSKEY_*.
// This turns that set into one of our PasskeyCredential objects, for both KeePass paths: the
// XML export and the .kdbx, which reach us as the same RawField pairs. It also writes the set,
// for the KDBX export, so the format is described once for both directions.
//
// One converter, deliberately, and not just to avoid duplication. Import de-duplication hashes
// the whole entry including its passkeys, so if the XML and .kdbx paths produced even slightly
// different bytes for the same credential, importing both would store the same private key
// twice and neither copy would be recognisable as a duplicate of the other.
//
// KeePassXC usually picks Ed25519, so most of these are EdDSA rather than ES256. The algorithm
// comes back from the crypto core, which reads it off the key's own OID.
// See docs/passkey-import.md.

import type { KdbxSaveEntry } from "../adapters/crypto";
import { pkcs8FromKey, pkcs8Pem } from "../exchange/passkey-key";
import type { PasskeyCredential } from "../hooks/useVault";
import { base64ToBase64Url, bytesToBase64 } from "../util/bytes";
import { passkeyCredentialSchema } from "../vault/entry-normalize";
import {
	bareBase64UrlToBase64,
	type ConversionTally,
	MAX_CREDENTIAL_ID_BYTES,
	pemToStandardBase64,
	reject,
	rejectionReason,
	userHandleToBase64,
	validRpId,
} from "./passkey-fields";
import type { RawField } from "./shared";
import type { ImportParserContext } from "./types";

const PREFIX = "KPEX_PASSKEY_";
const KPEX = {
	credentialId: `${PREFIX}CREDENTIAL_ID`,
	privateKeyPem: `${PREFIX}PRIVATE_KEY_PEM`,
	relyingParty: `${PREFIX}RELYING_PARTY`,
	username: `${PREFIX}USERNAME`,
	userHandle: `${PREFIX}USER_HANDLE`,
	flagBe: `${PREFIX}FLAG_BE`,
	flagBs: `${PREFIX}FLAG_BS`,
	// Ours, not KeePassXC's: what a passkey holds that its attributes can't say. Inside KeePassXC's
	// prefix on purpose, so KeePassXC hides it with the rest and deletes it with the passkey.
	bramble: `${PREFIX}BRAMBLE`,
} as const;
// Older KeePassXC builds spelled the handle this way. Read as a fallback so a database written
// by one of them still imports; we have not seen one, so it is tolerance, not a known format.
const LEGACY_USER_HANDLE = `${PREFIX}GENERATED_USER_ID`;

/**
 * The fields of a stored passkey KeePassXC has no attribute for, validated as the vault validates
 * them. The key itself re-derives `alg` and the public key, and the counter is always zero, so
 * those stay out. `credentialId` ties the set to its passkey.
 */
const extrasSchema = passkeyCredentialSchema.pick({
	credentialId: true,
	rpName: true,
	userDisplayName: true,
	createdAt: true,
	lastUsedAt: true,
	prf: true,
	fido2Extensions: true,
});
// A few hundred characters in practice; the cap bounds what a hostile file can make us parse.
const MAX_EXTRAS_CHARS = 64 * 1024;

/** True once an entry carries anything KeePassXC would have written for a passkey. */
export function hasKeepassPasskey(fields: RawField[]): boolean {
	return fields.some((f) => f.key.startsWith(PREFIX));
}

/** Split an entry's fields into the passkey attributes and everything else. */
export function partitionPasskeyFields(fields: RawField[]): {
	passkey: Map<string, string>;
	rest: RawField[];
} {
	const passkey = new Map<string, string>();
	const rest: RawField[] = [];
	for (const f of fields) {
		if (f.key.startsWith(PREFIX)) passkey.set(f.key, f.value);
		else rest.push(f);
	}
	return { passkey, rest };
}

function required(passkey: Map<string, string>, key: string, label: string): string {
	const value = passkey.get(key)?.trim();
	if (!value) reject(`has no ${label}`);
	return value;
}

export interface KeepassPasskeyOutcome {
	/** The converted credential, or null when this entry has none or conversion failed. */
	credential: PasskeyCredential | null;
	/** Fields to keep. The KPEX_* set is dropped on success and kept on failure. */
	fields: RawField[];
}

/**
 * Convert one entry's KeePassXC passkey attributes.
 *
 * On success the KPEX_* fields are dropped: keeping them would leave a second, plaintext copy
 * of the private key sitting in a custom field next to the real credential. On failure they are
 * kept exactly as they arrived, hidden flags and all, because a passkey we cannot read is still
 * the user's only copy and silently discarding it would be worse than showing it raw.
 */
export async function convertKeepassPasskey(
	fields: RawField[],
	entryName: string,
	importedAt: number,
	context: ImportParserContext,
	warnings: string[],
	tally: ConversionTally,
): Promise<KeepassPasskeyOutcome> {
	if (!hasKeepassPasskey(fields)) return { credential: null, fields };
	const { passkey, rest } = partitionPasskeyFields(fields);
	const label = `"${entryName}"`;

	const failed = (reason: string): KeepassPasskeyOutcome => {
		warnings.push(`The passkey on ${label} ${reason}, so it was kept as fields instead.`);
		tally.failed++;
		return { credential: null, fields };
	};

	let credentialId: string;
	let userHandle: string;
	let rpId: string;
	let pkcs8: string;
	try {
		credentialId = bareBase64UrlToBase64(
			required(passkey, KPEX.credentialId, "credential ID"),
			MAX_CREDENTIAL_ID_BYTES,
		);
		userHandle = userHandleToBase64(
			passkey.get(KPEX.userHandle)?.trim() || required(passkey, LEGACY_USER_HANDLE, "user handle"),
		);
		rpId = required(passkey, KPEX.relyingParty, "relying-party ID");
		if (!validRpId(rpId)) reject("has an invalid relying-party ID");
		pkcs8 = pemToStandardBase64(required(passkey, KPEX.privateKeyPem, "private key"));
	} catch (e) {
		const reason = rejectionReason(e);
		return failed(reason ?? "could not be read");
	}

	let material: Awaited<ReturnType<ImportParserContext["passkeyImportPkcs8"]>>;
	try {
		material = await context.passkeyImportPkcs8(pkcs8);
		if (!material.privateKey || !material.publicKeyCose) throw new Error("empty converted key");
	} catch {
		// Suppress the conversion error itself: it comes from the crypto core and could name
		// bytes of the key.
		tally.failed++;
		warnings.push(
			`The passkey on ${label} has key material we can't read, so it was kept as fields instead.`,
		);
		return { credential: null, fields };
	}

	tally.converted++;
	const extras = readExtras(passkey.get(KPEX.bramble), credentialId);
	if (!extras) {
		warnings.push(
			`The passkey on ${label} came with Bramble details we can't read, so they were kept as a field.`,
		);
	}
	return {
		credential: {
			credentialId,
			rpId,
			userHandle,
			userName: passkey.get(KPEX.username)?.trim() || undefined,
			// From the key's OID. KeePassXC prefers Ed25519, so this is usually -8, not -7.
			alg: material.alg,
			publicKeyCose: material.publicKeyCose,
			privateKey: material.privateKey,
			// Always zero: a counter that goes backwards across synced devices reads to a
			// relying party as a cloned authenticator.
			signCount: 0,
			// Deliberately the run's timestamp and not KeePassXC's: dedupe strips nested dates,
			// so this cannot make the same credential look new on a second import. A file Bramble
			// wrote carries the original in its details, which win.
			createdAt: importedAt,
			...extras,
		},
		fields: extras ? rest : [...rest, ...fields.filter((f) => f.key === KPEX.bramble)],
	};
}

/**
 * Bramble's own details for the passkey `credentialId`: `{}` when there are none, or when they
 * were left from a passkey KeePassXC has since replaced (it overwrites only its own attributes),
 * and null when they can't be read.
 */
function readExtras(
	raw: string | undefined,
	credentialId: string,
): Omit<Partial<PasskeyCredential>, "credentialId"> | null {
	if (raw === undefined) return {};
	if (raw.length > MAX_EXTRAS_CHARS) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const extras = extrasSchema.safeParse(parsed);
	if (!extras.success) return null;
	const { credentialId: owner, ...rest } = extras.data;
	return owner === credentialId ? rest : {};
}

/**
 * A stored passkey as KeePassXC's attributes, the inverse of `convertKeepassPasskey`: the names and
 * protection KeePassXC's own browser integration writes, ids as bare base64url and the key as
 * PKCS#8 PEM, plus Bramble's details. Null for a damaged passkey, whose key has no PKCS#8 form.
 */
export function keepassPasskeyAttributes(p: PasskeyCredential): KdbxSaveEntry["strings"] | null {
	const der = pkcs8FromKey(p.alg, p.privateKey);
	if (!der) return null;
	const extras = Object.fromEntries(
		Object.keys(extrasSchema.shape).map((k) => [k, p[k as keyof PasskeyCredential]]),
	);
	return [
		{ key: KPEX.username, value: p.userName ?? "", protected: false },
		{ key: KPEX.credentialId, value: base64ToBase64Url(p.credentialId), protected: true },
		{ key: KPEX.privateKeyPem, value: pkcs8Pem(bytesToBase64(der)), protected: true },
		{ key: KPEX.relyingParty, value: p.rpId, protected: false },
		{ key: KPEX.userHandle, value: base64ToBase64Url(p.userHandle), protected: true },
		// Bramble's passkeys sync, which is what these two say. KeePassXC sets both on its own.
		{ key: KPEX.flagBe, value: "1", protected: false },
		{ key: KPEX.flagBs, value: "1", protected: false },
		{ key: KPEX.bramble, value: JSON.stringify(extras), protected: true },
	];
}
