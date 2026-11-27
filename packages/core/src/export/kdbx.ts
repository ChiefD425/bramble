// EntryData -> KeePass String pairs, the inverse of import/keepass.ts `mapKeepassFields`.
//
// KeePass only models a login, so cards, notes and SSH keys are written as entries whose
// data lives in custom String fields (secrets marked Protected). Re-importing them yields a
// login carrying those fields, which is what the KDBX import path already does with any
// foreign database. Nothing is dropped; the type label is what KeePass can't carry.
//
// Tags are the exception to the String-pair rule: `Tags` is lifted by the Rust writer
// into KeePass's own `<Tags>` element (see TAGS_KEY in core-rust/src/kdbx.rs), so it
// round-trips as a real tag rather than a field that happens to be named one.
//
// Archived entries are exported alongside live ones with an `Archived` String field. The
// natural KeePass home for them would be the recycle-bin group, but this writer emits a
// flat entry list (the KDBX writer takes entries, not groups), and an archived entry is not
// deleted anyway. So the state rides as a field, on the same terms as the type label.
//
// Passkeys go in as KeePassXC stores them (see import/keepass-passkey.ts), so KeePassXC signs in
// with them. KeePassXC holds one passkey per entry: a login's first sits on the login, and each
// further one gets an entry of its own.

import type { KdbxSaveEntry, KdbxSaveFile } from "../adapters/crypto";
import type { EntryData, LoginEntryData, PasskeyCredential } from "../hooks/useVault";
import { keepassPasskeyAttributes } from "../import/keepass-passkey";
import type { FileRecord } from "../sync";
import { parseTotp } from "../util/totp";
import type { FileMeta } from "../vault/file-mutations";

type Pair = { key: string; value: string; protected: boolean };

/**
 * Collects String pairs, dropping empties and keeping keys unique. Callers add the
 * type's own fields first and custom fields last, so a custom key that would shadow
 * one (a field literally named "Password") is the one that gets suffixed.
 */
/** The field KeePassXC and Keepass2Android read extra URLs from, by prefix. */
const EXTRA_URL = "KP2A_URL";

class Fields {
	private readonly out: Pair[] = [];
	private readonly seen = new Set<string>();

	add(key: string, value: string | undefined, isProtected = false): void {
		if (!key || !value) return;
		this.out.push({ key: this.unique(key), value, protected: isProtected });
	}

	/** Two <String>s sharing a <Key> is malformed, and losing the value is worse. */
	private unique(key: string): string {
		if (!this.seen.has(key)) {
			this.seen.add(key);
			return key;
		}
		let n = 2;
		while (this.seen.has(`${key} (${n})`)) n++;
		const candidate = `${key} (${n})`;
		this.seen.add(candidate);
		return candidate;
	}

	done(): Pair[] {
		return this.out;
	}
}

/** KeePassXC reads a full `otpauth://` URI from `otp`, and a Steam key as `encoder=steam`; a bare
 * base32 secret is the KeeOtp `TOTP Seed` convention. Our own importer accepts all three. */
function addTotp(f: Fields, totp: string): void {
	const steam = parseTotp(totp);
	if (steam?.steam) {
		const label = encodeURIComponent(`Steam:${steam.account}`);
		f.add(
			"otp",
			`otpauth://totp/${label}?secret=${steam.totp.secret.base32}&issuer=Steam&encoder=steam`,
			true,
		);
	} else if (/^otpauth:\/\//i.test(totp.trim())) f.add("otp", totp, true);
	else f.add("TOTP Seed", totp, true);
}

/** A stored passkey whose key has no PKCS#8 form. Only a damaged passkey has one. */
export class UnexportablePasskeyError extends Error {
	constructor(readonly entryName: string) {
		super(`a passkey on "${entryName}" has a key that can't be written`);
		this.name = "UnexportablePasskeyError";
	}
}

function addPasskey(f: Fields, p: PasskeyCredential, entryName: string): void {
	const attributes = keepassPasskeyAttributes(p);
	if (!attributes) throw new UnexportablePasskeyError(entryName);
	for (const a of attributes) f.add(a.key, a.value, a.protected);
}

/** Tags and the archived state, which a login's further passkeys share with it. */
function addLabels(f: Fields, e: EntryData): void {
	// KeePass has a first-class Tags element and the Rust writer lifts this pair into it,
	// so tags land in a KeePass client's own tag column, not a custom field. Comma-joined
	// is KeePass's own separator.
	if (e.tags?.length) f.add("Tags", e.tags.join(","));
	// ISO 8601 rather than epoch ms: a human reading the field in KeePass should see a date.
	if (e.archivedAt !== undefined) f.add("Archived", new Date(e.archivedAt).toISOString());
}

function toFields(e: EntryData): Pair[] {
	const f = new Fields();
	f.add("Title", e.name);
	f.add("Notes", e.notes);
	addLabels(f, e);

	if (e.type === "login") {
		f.add("UserName", e.username);
		f.add("Password", e.password, true);
		// KeePass 2.x carries one URL per entry. The rest go where KeePassXC and Keepass2Android
		// keep extra URLs: KP2A_URL, then KP2A_URL_1, KP2A_URL_2 and so on (#277).
		const [first, ...rest] = e.urls;
		f.add("URL", first);
		for (const [i, u] of rest.entries()) f.add(i === 0 ? EXTRA_URL : `${EXTRA_URL}_${i}`, u);
		if (e.totp) addTotp(f, e.totp);
		const [passkey] = e.passkeys ?? [];
		if (passkey) addPasskey(f, passkey, e.name);
	} else if (e.type === "card") {
		f.add("Cardholder Name", e.cardholderName);
		f.add("Number", e.number, true);
		f.add("Brand", e.brand);
		f.add("Expiry Month", e.expMonth);
		f.add("Expiry Year", e.expYear);
		f.add("CVV", e.cvv, true);
	} else if (e.type === "ssh-key") {
		f.add("Key Type", e.keyType);
		f.add("Public Key", e.publicKey);
		f.add("Private Key", e.privateKey, true);
		f.add("Passphrase", e.passphrase, true);
		f.add("Hosts", e.hosts?.join("\n"));
	}

	for (const c of e.customFields ?? []) f.add(c.key, c.value, c.hidden === true);
	return f.done();
}

/** A login's further passkey, as KeePassXC files one: titled, with its account and site. */
function passkeyEntryFields(e: LoginEntryData, p: PasskeyCredential): Pair[] {
	const f = new Fields();
	f.add("Title", e.name);
	addLabels(f, e);
	f.add("UserName", p.userName);
	f.add("URL", `https://${p.rpId}`);
	addPasskey(f, p, e.name);
	return f.done();
}

/**
 * Map decrypted vault entries to the KeePass entries the KDBX writer expects. The n-th entry
 * written is the n-th one given; after them comes one for each passkey past a login's first.
 */
export function toKdbxEntries(entries: readonly EntryData[]): KdbxSaveEntry[] {
	const out = entries.map((e) => ({ strings: toFields(e) }));
	for (const e of entries) {
		if (e.type !== "login") continue;
		for (const p of e.passkeys?.slice(1) ?? []) out.push({ strings: passkeyEntryFields(e, p) });
	}
	return out;
}

/**
 * A whole vault's KeePass export: its entries and passkeys, and every attachment on the entry it
 * belongs to.
 * One whose entry is gone (deleted on another device before the file's record caught up) goes
 * on one extra entry titled `looseTitle`, rather than not at all.
 */
export async function toKdbxExport(
	entries: readonly (EntryData & { id: string })[],
	files: readonly FileRecord[],
	looseTitle: string,
	describe: (record: FileRecord) => Promise<FileMeta>,
): Promise<{ entries: KdbxSaveEntry[]; files: KdbxSaveFile[] }> {
	const out = toKdbxEntries(entries);
	const at = new Map(entries.map((e, i) => [e.id, i]));
	let loose: number | undefined;
	const taken = new Map<number, Set<string>>();
	const placed: KdbxSaveFile[] = [];
	for (const record of files) {
		let entry = record.entryId === undefined ? undefined : at.get(record.entryId);
		if (entry === undefined) {
			loose ??= out.push({ strings: [{ key: "Title", value: looseTitle, protected: false }] }) - 1;
			entry = loose;
		}
		const names = taken.get(entry) ?? new Set<string>();
		taken.set(entry, names);
		placed.push({ entry, record, name: uniqueName((await describe(record)).name, names) });
	}
	return { entries: out, files: placed };
}

/** `name`, or `name (2).ext` and on, so no two attachments on one entry share a name. */
function uniqueName(name: string, taken: Set<string>): string {
	let candidate = name;
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	for (let n = 2; taken.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
	taken.add(candidate);
	return candidate;
}
