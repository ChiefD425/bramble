// The sync group's device roster: a convergent CRDT of member devices, reusing
// the same merge kernel as entries. Each device carries the public key used for
// roster-anchored channel auth (phase 3b). Revocation is a tombstone, so a
// removed device stays removed across a merge; re-enrolling a device (a strictly
// newer stamp) brings it back. The roster syncs with the vault so every device
// knows the membership. See docs/p2p-sync.md.

import { z } from "zod";
import { type Tombstone, TombstoneSchema } from "./entries-payload";
import { type Hlc, HlcSchema, isFutureStamp } from "./hlc";
import { SIG_KEY_RE } from "./mailbox/protocol";
import { mergeReplicas, type ReplicaState, replicaFrom } from "./merge";

/** One member device. `id` is the device's node id (the same id used in HLC stamps). */
export const RosterEntrySchema = z.object({
	id: z.string().min(1),
	/** Public key for roster-anchored channel auth, base64. */
	publicKey: z.string().min(1),
	/** User-facing device name. */
	label: z.string(),
	/** Wall-clock enrollment time, for display only. */
	addedAt: z.number().int().nonnegative(),
	hlc: HlcSchema,
	/** Ed25519 verify key that signs this entry (base64). Optional through the phase-1 rollout
	 * (Item A): absent on legacy/unsigned entries. See docs/p2p-sync-revocation-hardening.md. */
	sigKey: z.string().min(1).optional(),
	/** Ed25519 signature over `canonicalRosterEntry` (base64). Optional through phase-1. */
	sig: z.string().min(1).optional(),
	/** Ed25519 verify key for admitting NEW devices (base64), derived from the master password at
	 * registration (never at rest). Published here - covered by `sig` - so peers can verify who this
	 * device admits. Optional through rollout. See docs/p2p-sync-revocation-hardening.md. */
	admissionKey: z.string().min(1).optional(),
	/** Admission of a NON-initial device: the admitting member's id + its signature over this entry's
	 * canonical. Absent for the initial enrolled set (bootstrapped via the PSK ceremony). */
	admission: z
		.object({
			by: z.string().min(1),
			sig: z.string().min(1),
			/** The same admission over `canonicalAdmission`, which outlasts a re-stamp. */
			stableSig: z.string().min(1).optional(),
		})
		.optional(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

/** The stable string signed for a roster entry: binds `id` <-> `publicKey` <-> `sigKey` <->
 * `admissionKey` <-> stamp, so a member cannot rewrite another device's entry, swap its keys, or
 * backdate one. Excludes the mutable display `label`, the `sig`, and the `admission` (the admitter
 * signs THIS same string). TS and core-rust MUST produce byte-identical output; the pinned test
 * vector is the cross-language contract. Fixed-order array avoids object-key-order ambiguity. */
export function canonicalRosterEntry(entry: RosterEntry): string {
	return JSON.stringify([
		entry.id,
		entry.publicKey,
		entry.sigKey ?? "",
		entry.admissionKey ?? "",
		entry.addedAt,
		entry.hlc.wall,
		entry.hlc.counter,
		entry.hlc.node,
	]);
}

/** What an admission's `stableSig` signs: the entry's identity and keys, without the stamp or its
 * own admission key, so the admission still holds after the device re-stamps its entry. */
export function canonicalAdmission(entry: RosterEntry): string {
	return JSON.stringify([
		"bramble/admission/v2",
		entry.id,
		entry.publicKey,
		entry.sigKey ?? "",
		entry.addedAt,
	]);
}

/** Admit `entry` as member `by`: signed over both forms, so devices that predate the stable one
 * still verify it. */
export async function admitEntry(
	entry: RosterEntry,
	by: string,
	sign: (message: string) => Promise<string>,
): Promise<RosterEntry> {
	const sig = await sign(canonicalRosterEntry(entry));
	const stableSig = await sign(canonicalAdmission(entry));
	return { ...entry, admission: { by, sig, stableSig } };
}

/** Attach this device's Ed25519 `sigKey` + `sig` to its own roster entry (Item A). The signature
 * covers the canonical form *including* the sigKey, so `sigKey` is set before signing. `sign` is the
 * host's Ed25519 signer over the canonical string. See docs/p2p-sync-revocation-hardening.md. */
export async function signRosterEntry(
	entry: RosterEntry,
	sigKey: string,
	sign: (canonical: string) => Promise<string>,
): Promise<RosterEntry> {
	const withKey: RosterEntry = { ...entry, sigKey };
	return { ...withKey, sig: await sign(canonicalRosterEntry(withKey)) };
}

/** The stored/wire roster: active devices plus the revocation graveyard. */
export const RosterPayloadSchema = z.object({
	devices: z.array(RosterEntrySchema),
	revoked: z.array(TombstoneSchema),
	/** Keys of revoked devices, sorted; absent when none. An entry carrying one is dead unless an
	 * admission brought it back, so a revoked device can't return under a new id. */
	revokedKeys: z.array(z.string().min(1)).optional(),
});
export type RosterPayload = z.infer<typeof RosterPayloadSchema>;

export function emptyRoster(): RosterPayload {
	return { devices: [], revoked: [] };
}

export function encodeRoster(roster: RosterPayload): string {
	return JSON.stringify(RosterPayloadSchema.parse(roster));
}

export function decodeRoster(json: string): RosterPayload {
	return RosterPayloadSchema.parse(JSON.parse(json));
}

function toReplica(roster: RosterPayload): ReplicaState<RosterEntry> {
	return replicaFrom(
		roster.devices,
		roster.revoked.map((t) => [t.id, t.hlc] as const),
	);
}

/** Roster liveness is STICKY: a tombstoned id is dead regardless of any record's stamp, so a
 * revoked device can never be resurrected by a re-add (closes B1). Re-adding a removed device is a
 * fresh enrollment with a fresh id, not a reuse of the dead one. This differs deliberately from the
 * shared `liveRecords` (last-writer-wins), which the entries CRDT still needs. See
 * docs/p2p-sync-revocation-hardening.md. */
function liveDevices(state: ReplicaState<RosterEntry>): RosterEntry[] {
	const out: RosterEntry[] = [];
	for (const [id, rec] of state.records) {
		if (!state.tombstones.has(id)) out.push(rec);
	}
	return out;
}

function toPayload(state: ReplicaState<RosterEntry>): RosterPayload {
	return {
		devices: liveDevices(state),
		revoked: [...state.tombstones].map(([id, hlc]) => ({ id, hlc })),
	};
}

const keysOf = (entry: RosterEntry) => [entry.publicKey, ...(entry.sigKey ? [entry.sigKey] : [])];

/** Whether two entries carry a key in common: the same device, whatever their ids. */
export function sharesKey(a: RosterEntry, b: RosterEntry): boolean {
	const keys = new Set(keysOf(a));
	return keysOf(b).some((key) => keys.has(key));
}

/** Whether an entry carries a revoked device's key with no admission to bring it back. */
function onRevokedKey(entry: RosterEntry, revoked: ReadonlySet<string>): boolean {
	return entry.admission === undefined && keysOf(entry).some((key) => revoked.has(key));
}

/** Whether an entry carries a revoked device's key, admitted or not: a joiner only an admission
 * signed by this group can seat. */
export function carriesRevokedKey(roster: RosterPayload, entry: RosterEntry): boolean {
	const gone = new Set(roster.revokedKeys ?? []);
	return keysOf(entry).some((key) => gone.has(key));
}

/** `roster` with `keys` revoked: its entries carrying one dropped, the field absent when empty. */
function withRevokedKeys(roster: RosterPayload, keys: string[]): RosterPayload {
	if (keys.length === 0) return roster;
	const revokedKeys = [...new Set(keys)].sort();
	const gone = new Set(revokedKeys);
	return {
		devices: roster.devices.filter((d) => !onRevokedKey(d, gone)),
		revoked: roster.revoked,
		revokedKeys,
	};
}

/** Merge two rosters. Same convergence guarantees as the entries merge. */
export function mergeRosters(a: RosterPayload, b: RosterPayload): RosterPayload {
	return withRevokedKeys(toPayload(mergeReplicas(toReplica(a), toReplica(b))), [
		...(a.revokedKeys ?? []),
		...(b.revokedKeys ?? []),
	]);
}

/** Drop device entries and tombstones stamped implausibly far in the future before merging a
 * REMOTELY-received roster. Without this a malicious member could gossip its own entry stamped
 * years ahead, so a later revocation tombstone (stamped ~now) could never win the merge and the
 * device would be permanently un-revocable. Honest rosters carry near-present stamps. */
export function sanitizeRemoteRoster(
	roster: RosterPayload,
	now: number = Date.now(),
): RosterPayload {
	return {
		devices: roster.devices.filter((d) => !isFutureStamp(d.hlc, now)),
		revoked: roster.revoked.filter((t) => !isFutureStamp(t.hlc, now)),
		...(roster.revokedKeys ? { revokedKeys: roster.revokedKeys } : {}),
	};
}

/** Merge a peer's roster into the local one, dropping future-dated (poisoned) stamps first.
 * Hosts MUST use this for a remotely-received roster instead of mergeRosters directly. */
export function mergeRemoteRoster(
	local: RosterPayload,
	remote: RosterPayload,
	now: number = Date.now(),
): RosterPayload {
	return mergeRosters(local, sanitizeRemoteRoster(remote, now));
}

/**
 * Verify a REMOTELY-received roster's device entries before merge (Item A). Drops entries that fail
 * Ed25519 verification or violate the TOFU id->key binding, so a compromised member cannot
 * impersonate another device (rewrite its entry with a different key). `isSigValid` is the
 * host-computed signature verdict for a signed entry (the Ed25519 verify runs in the crypto host
 * over `canonicalRosterEntry`; core stays pure/sync). Rules:
 *  - A device we already know as signing (its id has an established `sigKey`) MUST re-present the
 *    same `sigKey` with a valid signature: no key swap (impersonation) and no downgrade to unsigned.
 *  - An id not yet established accepts an unsigned entry (verify-if-present, phase-1 rollout); a
 *    signed one is validated. (The phase-1 establishment window is closed by phase 2 "require".)
 *  - A revoked (locally-tombstoned) id is dropped: gossip cannot re-add a removed device (B1).
 *    Combined with the sticky liveness in `liveDevices`, a tombstoned id stays dead for good.
 *  - A brand-new (never-seen) id carrying an `admission` is admitted only if `isAdmissionValid`
 *    (the admitting member's password-derived admission key verifies it) - closing rogue-injection.
 *    A new id with no admission is tolerated in phase 1; phase-2 "require" flips that off (#4).
 *  - Tombstones pass through untouched: revocation stays member-level authority.
 * Hosts run this before mergeRemoteRoster. See docs/p2p-sync-revocation-hardening.md.
 */
export function verifyRemoteRoster(
	local: RosterPayload,
	remote: RosterPayload,
	isSigValid: (entry: RosterEntry) => boolean,
	isAdmissionValid: (entry: RosterEntry) => boolean,
	require: { signatures?: boolean; admission?: boolean } = {},
): RosterPayload {
	const anchored = new Map<string, string>(); // known id -> its established (first-seen) sigKey
	for (const d of local.devices) if (d.sigKey) anchored.set(d.id, d.sigKey);
	const tombstoned = new Set(local.revoked.map((t) => t.id)); // revoked ids stay dead (B1)
	const known = new Map(local.devices.map((d) => [d.id, d]));
	const devices = remote.devices.flatMap((entry): RosterEntry[] => {
		if (tombstoned.has(entry.id)) return [];
		const anchor = anchored.get(entry.id);
		if (anchor !== undefined) {
			// Established signing device: same key + valid signature (no swap, no downgrade).
			if (!(entry.sigKey === anchor && entry.sig !== undefined && isSigValid(entry))) return [];
			// The signature doesn't cover the admission, and an admission keeps a revoked key alive:
			// a changed one, or one on changed keys, counts only if it verifies. One that doesn't is
			// dropped, never swapped for the old, so every device ends with the same entry.
			const had = known.get(entry.id);
			if (
				had &&
				sameAdmission(entry.admission, had.admission) &&
				canonicalAdmission(entry) === canonicalAdmission(had)
			)
				return [entry];
			if (entry.admission !== undefined && isAdmissionValid(entry)) return [entry];
			const { admission: _changed, ...rest } = entry;
			return [rest];
		}
		// Brand-new id: self-sign + admission gates. Verify-if-present in phase 1; the `require` flags
		// (from core flags.json) flip enforcement on in phase 2.
		if (entry.sigKey !== undefined && entry.sig !== undefined) {
			if (!isSigValid(entry)) return [];
		} else if (require.signatures) {
			return []; // phase-2: reject an unsigned new id
		}
		if (entry.admission !== undefined) return isAdmissionValid(entry) ? [entry] : [];
		// phase-1: tolerate; phase-2: reject an unadmitted new id
		return require.admission ? [] : [entry];
	});
	return {
		devices,
		revoked: remote.revoked,
		...(remote.revokedKeys ? { revokedKeys: remote.revokedKeys } : {}),
	};
}

// A copy from before stable signatures is the same admission, or devices would part ways for good.
const sameAdmission = (a: RosterEntry["admission"], b: RosterEntry["admission"]) =>
	a?.by === b?.by &&
	a?.sig === b?.sig &&
	(!a?.stableSig || !b?.stableSig || a.stableSig === b.stableSig);

/** Enroll (or re-enroll) a device. The entry must carry a freshly stamped hlc. */
export function addDevice(roster: RosterPayload, device: RosterEntry): RosterPayload {
	return mergeRosters(roster, { devices: [device], revoked: [] });
}

/** Keys this roster revoked and no active device holds again. */
export function removedKeys(roster: RosterPayload): string[] {
	const held = new Set(activeDevices(roster).flatMap(keysOf));
	return (roster.revokedKeys ?? []).filter((key) => !held.has(key));
}

/** Whether a joiner's entry may be enrolled: a fresh id, or a member re-presenting its own key. A
 * taken id under another key would evict that member by LWW. */
export function mayEnroll(roster: RosterPayload, entry: RosterEntry): boolean {
	if (roster.revoked.some((t) => t.id === entry.id)) return false;
	const held = roster.devices.find((d) => d.id === entry.id);
	return !held || held.publicKey === entry.publicKey;
}

/** Revoke a device and its keys. `hlc` must be a freshly stamped revocation stamp. */
export function revokeDevice(roster: RosterPayload, id: string, hlc: Hlc): RosterPayload {
	const target = roster.devices.find((d) => d.id === id);
	const keys = target ? keysOf(target) : [];
	return mergeRosters(roster, {
		devices: [],
		revoked: [{ id, hlc }],
		...(keys.length > 0 ? { revokedKeys: keys } : {}),
	});
}

/** The other active devices that removing `id` takes with it: they carry its keys, unadmitted. */
export function alsoRemoved(roster: RosterPayload, id: string): RosterEntry[] {
	const active = activeDevices(roster);
	const target = active.find((d) => d.id === id);
	if (!target) return [];
	const keys = new Set(keysOf(target));
	return active.filter((d) => d.id !== id && onRevokedKey(d, keys));
}

/** The currently active member devices (not revoked). */
export function activeDevices(roster: RosterPayload): RosterEntry[] {
	const gone = new Set(roster.revokedKeys ?? []);
	return liveDevices(toReplica(roster)).filter((d) => !onRevokedKey(d, gone));
}

/** Active devices' sigKeys, canonical and deduplicated: who a mailbox should list. */
export function activeSigKeys(roster: RosterPayload): string[] {
	const keys = activeDevices(roster).flatMap((d) =>
		d.sigKey && SIG_KEY_RE.test(d.sigKey) ? [d.sigKey] : [],
	);
	return [...new Set(keys)];
}

/** True iff `id` is an active member (used to gate roster-auth handshakes). */
export function isActiveDevice(roster: RosterPayload, id: string): boolean {
	return activeDevices(roster).some((d) => d.id === id);
}

/** Whether any roster holds a signed entry for `publicKey`: that device has had a signing key. */
export function hasSignedEntry(rosters: RosterPayload[], publicKey: string): boolean {
	return rosters.some((r) => r.devices.some((d) => d.publicKey === publicKey && !!d.sigKey));
}

/** The active device with this id, or undefined. */
export function findDevice(roster: RosterPayload, id: string): RosterEntry | undefined {
	return activeDevices(roster).find((d) => d.id === id);
}

export type { Tombstone };
