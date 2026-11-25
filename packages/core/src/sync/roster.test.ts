import { describe, expect, it } from "vitest";
import { HLC_MAX_DRIFT_MS, type Hlc } from "./hlc";
import {
	activeDevices,
	activeSigKeys,
	addDevice,
	admitEntry,
	alsoRemoved,
	canonicalAdmission,
	canonicalRosterEntry,
	carriesRevokedKey,
	decodeRoster,
	emptyRoster,
	encodeRoster,
	findDevice,
	hasSignedEntry,
	isActiveDevice,
	mayEnroll,
	mergeRemoteRoster,
	mergeRosters,
	type RosterEntry,
	RosterEntrySchema,
	type RosterPayload,
	revokeDevice,
	sanitizeRemoteRoster,
	signRosterEntry,
	verifyRemoteRoster,
} from "./roster";

const hlc = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });
const device = (id: string, wall: number, label = id): RosterEntry => ({
	id,
	publicKey: `pk-${id}`,
	label,
	addedAt: wall,
	hlc: hlc(wall, id),
});

const ids = (r: RosterPayload) =>
	activeDevices(r)
		.map((d) => d.id)
		.sort();

describe("roster entry signing foundation (Item A)", () => {
	it("parses a legacy entry with no sigKey/sig (backward compatible)", () => {
		const legacy = { id: "laptop", publicKey: "pk", label: "L", addedAt: 1, hlc: hlc(1, "laptop") };
		const parsed = RosterEntrySchema.parse(legacy);
		expect(parsed.sigKey).toBeUndefined();
		expect(parsed.sig).toBeUndefined();
		// A legacy roster round-trips through encode/decode unchanged.
		const r = addDevice(emptyRoster(), legacy);
		expect(decodeRoster(encodeRoster(r))).toEqual(r);
	});

	it("parses and round-trips a signed entry", () => {
		const signed = { ...device("phone", 5), sigKey: "sk-phone", sig: "sig-phone" };
		const parsed = RosterEntrySchema.parse(signed);
		expect(parsed.sigKey).toBe("sk-phone");
		const r = addDevice(emptyRoster(), signed);
		expect(findDevice(r, "phone")?.sig).toBe("sig-phone");
	});

	it("canonical form is deterministic and pins a cross-language vector", () => {
		const entry: RosterEntry = {
			id: "laptop",
			publicKey: "pk-laptop",
			label: "My laptop",
			addedAt: 1700000000000,
			hlc: { wall: 1700000000000, counter: 3, node: "laptop" },
			sigKey: "sk-laptop",
		};
		// Fixed-order array of [id, publicKey, sigKey, admissionKey, addedAt, wall, counter, node].
		// core-rust must reproduce these exact bytes; if this vector changes, the signer must too.
		expect(canonicalRosterEntry(entry)).toBe(
			'["laptop","pk-laptop","sk-laptop","",1700000000000,1700000000000,3,"laptop"]',
		);
		expect(canonicalRosterEntry({ ...entry })).toBe(canonicalRosterEntry(entry));
	});

	it("signRosterEntry attaches sigKey + sig over the canonical form (which includes sigKey)", async () => {
		const base = device("phone", 5);
		let signedCanonical = "";
		const sign = async (c: string) => {
			signedCanonical = c;
			return "the-sig";
		};
		const out = await signRosterEntry(base, "sk-phone", sign);
		expect(out.sigKey).toBe("sk-phone");
		expect(out.sig).toBe("the-sig");
		expect(signedCanonical).toBe(canonicalRosterEntry({ ...base, sigKey: "sk-phone" }));
	});

	it("canonical form ignores the mutable label but binds identity + stamp", () => {
		const base: RosterEntry = {
			id: "phone",
			publicKey: "pk-phone",
			label: "Phone",
			addedAt: 10,
			hlc: hlc(10, "phone"),
			sigKey: "sk-phone",
		};
		// Renaming the device does not change what was signed.
		expect(canonicalRosterEntry({ ...base, label: "Renamed" })).toBe(canonicalRosterEntry(base));
		// Any identity/stamp field does.
		expect(canonicalRosterEntry({ ...base, publicKey: "pk-evil" })).not.toBe(
			canonicalRosterEntry(base),
		);
		expect(canonicalRosterEntry({ ...base, sigKey: "sk-evil" })).not.toBe(
			canonicalRosterEntry(base),
		);
		expect(canonicalRosterEntry({ ...base, hlc: hlc(11, "phone") })).not.toBe(
			canonicalRosterEntry(base),
		);
	});
});

describe("a joiner adding itself to the roster it was sent", () => {
	const inviter = device("laptop", 1);
	const own = { ...device("phone", 3), publicKey: "pk-phone", sigKey: "sk-phone" };
	const admitted = { ...own, admission: { by: "laptop", sig: "s", stableSig: "st" } };
	const firstTime: RosterPayload = { devices: [inviter], revoked: [] };
	const removed = revokeDevice(
		{
			devices: [inviter, { ...device("old", 1), publicKey: "pk-phone", sigKey: "sk-phone" }],
			revoked: [],
		},
		"old",
		hlc(2, "laptop"),
	);

	it("keeps the admitted copy, so its next re-stamp still carries the admission", () => {
		for (const group of [firstTime, removed]) {
			const joined = addDevice(addDevice(group, admitted), own);
			expect(joined.devices.find((d) => d.id === "phone")?.admission?.stableSig).toBe("st");
		}
	});

	it("sees a re-added device's own entry at once, not only after gossip", () => {
		expect(isActiveDevice(addDevice(removed, own), "phone")).toBe(false);
		expect(isActiveDevice(addDevice(addDevice(removed, admitted), own), "phone")).toBe(true);
	});
});

describe("verifyRemoteRoster (TOFU id->key binding, Item A)", () => {
	const signed = (id: string, wall: number, sigKey: string, sig = "valid"): RosterEntry => ({
		...device(id, wall),
		sigKey,
		sig,
	});
	// Mock the host's Ed25519 verdict: an entry stamped `sig: "valid"` verifies, anything else fails.
	const isValid = (e: RosterEntry) => e.sig === "valid";
	// Mock the admission verdict: an admission stamped `sig: "adm-valid"` verifies.
	const admValid = (e: RosterEntry) => e.admission?.sig === "adm-valid";
	const idsOf = (r: RosterPayload) => r.devices.map((d) => d.id).sort();

	it("accepts unsigned or validly-signed entries for ids not yet established", () => {
		const remote: RosterPayload = {
			devices: [device("plain", 1), signed("signer", 2, "sk-signer")],
			revoked: [],
		};
		expect(idsOf(verifyRemoteRoster(emptyRoster(), remote, isValid, admValid))).toEqual([
			"plain",
			"signer",
		]);
	});

	it("drops a signed entry whose signature does not verify", () => {
		const remote: RosterPayload = { devices: [signed("bad", 1, "sk-bad", "forged")], revoked: [] };
		expect(verifyRemoteRoster(emptyRoster(), remote, isValid, admValid).devices).toEqual([]);
	});

	it("TOFU: rejects a swapped sigKey for a known signing device (impersonation)", () => {
		const local = addDevice(emptyRoster(), signed("laptop", 1, "sk-laptop"));
		// Attacker re-presents laptop's id with its own key + a signature valid under that key.
		const remote: RosterPayload = { devices: [signed("laptop", 5, "sk-attacker")], revoked: [] };
		expect(verifyRemoteRoster(local, remote, isValid, admValid).devices).toEqual([]);
	});

	it("no downgrade: rejects an unsigned entry for a known signing device", () => {
		const local = addDevice(emptyRoster(), signed("laptop", 1, "sk-laptop"));
		const remote: RosterPayload = { devices: [device("laptop", 5)], revoked: [] };
		expect(verifyRemoteRoster(local, remote, isValid, admValid).devices).toEqual([]);
	});

	it("accepts a same-key, validly-signed update to a known signing device", () => {
		const local = addDevice(emptyRoster(), signed("laptop", 1, "sk-laptop"));
		const remote: RosterPayload = { devices: [signed("laptop", 5, "sk-laptop")], revoked: [] };
		expect(idsOf(verifyRemoteRoster(local, remote, isValid, admValid))).toEqual(["laptop"]);
	});

	it("drops a gossiped re-add of a locally-revoked id, even validly signed (B1)", () => {
		let local = addDevice(emptyRoster(), signed("phone", 1, "sk-phone"));
		local = revokeDevice(local, "phone", hlc(5, "me"));
		// Attacker re-gossips phone with a valid signature and a newer stamp; the tombstone wins.
		const remote: RosterPayload = { devices: [signed("phone", 9, "sk-phone")], revoked: [] };
		expect(verifyRemoteRoster(local, remote, isValid, admValid).devices).toEqual([]);
	});

	it("passes tombstones through untouched (revocation stays member-level)", () => {
		const remote: RosterPayload = { devices: [], revoked: [{ id: "gone", hlc: hlc(9, "x") }] };
		expect(verifyRemoteRoster(emptyRoster(), remote, isValid, admValid).revoked).toEqual(
			remote.revoked,
		);
	});

	// A member with a published admission key admits a new device.
	const admitted = (id: string, wall: number, by: string, sig = "adm-valid"): RosterEntry => ({
		...signed(id, wall, `sk-${id}`),
		admissionKey: `adm-${id}`,
		admission: { by, sig },
	});
	const withAdmissionKey = (id: string, wall: number) => ({
		...signed(id, wall, `sk-${id}`),
		admissionKey: `adm-${id}`,
	});

	it("admits a brand-new id with a valid admission by a current member", () => {
		const local: RosterPayload = { devices: [withAdmissionKey("laptop", 1)], revoked: [] };
		const remote: RosterPayload = { devices: [admitted("phone", 5, "laptop")], revoked: [] };
		expect(idsOf(verifyRemoteRoster(local, remote, isValid, admValid))).toEqual(["phone"]);
	});

	it("drops a brand-new id whose admission does not verify (rogue-injection)", () => {
		const local: RosterPayload = { devices: [withAdmissionKey("laptop", 1)], revoked: [] };
		// A compromised member conjures `rogue` with a self-made, unverifiable admission.
		const remote: RosterPayload = {
			devices: [admitted("rogue", 5, "laptop", "forged")],
			revoked: [],
		};
		expect(verifyRemoteRoster(local, remote, isValid, admValid).devices).toEqual([]);
	});

	it("tolerates a brand-new unadmitted id in phase 1 (verify-if-present)", () => {
		const remote: RosterPayload = { devices: [device("newbie", 5)], revoked: [] };
		expect(idsOf(verifyRemoteRoster(emptyRoster(), remote, isValid, admValid))).toEqual(["newbie"]);
	});

	it("phase-2 require.signatures rejects an unsigned new id", () => {
		const remote: RosterPayload = { devices: [device("newbie", 5)], revoked: [] };
		const out = verifyRemoteRoster(emptyRoster(), remote, isValid, admValid, { signatures: true });
		expect(out.devices).toEqual([]);
	});

	it("phase-2 require.admission rejects an unadmitted new id but keeps a validly-admitted one", () => {
		const local: RosterPayload = { devices: [withAdmissionKey("laptop", 1)], revoked: [] };
		const unadmitted: RosterPayload = { devices: [signed("solo", 5, "sk-solo")], revoked: [] };
		expect(
			verifyRemoteRoster(local, unadmitted, isValid, admValid, { admission: true }).devices,
		).toEqual([]);
		const admittedRemote: RosterPayload = {
			devices: [admitted("phone", 5, "laptop")],
			revoked: [],
		};
		expect(
			idsOf(verifyRemoteRoster(local, admittedRemote, isValid, admValid, { admission: true })),
		).toEqual(["phone"]);
	});
});

describe("roster add/revoke", () => {
	it("adds devices", () => {
		let r = emptyRoster();
		r = addDevice(r, device("laptop", 100));
		r = addDevice(r, device("phone", 200));
		expect(ids(r)).toEqual(["laptop", "phone"]);
		expect(isActiveDevice(r, "phone")).toBe(true);
		expect(findDevice(r, "laptop")?.publicKey).toBe("pk-laptop");
	});

	it("revokes a device so it is no longer active", () => {
		let r = addDevice(emptyRoster(), device("phone", 100));
		r = revokeDevice(r, "phone", hlc(200, "laptop"));
		expect(ids(r)).toEqual([]);
		expect(isActiveDevice(r, "phone")).toBe(false);
	});

	it("does not let a stale copy of a revoked device resurrect it", () => {
		let r = addDevice(emptyRoster(), device("phone", 100));
		r = revokeDevice(r, "phone", hlc(300, "laptop"));
		const stale = addDevice(emptyRoster(), device("phone", 100));
		expect(ids(mergeRosters(r, stale))).toEqual([]);
		expect(ids(mergeRosters(stale, r))).toEqual([]);
	});

	it("re-adding a revoked id stays dead (sticky tombstone, B1); a fresh id is required", () => {
		let r = addDevice(emptyRoster(), device("phone", 100));
		r = revokeDevice(r, "phone", hlc(200, "laptop"));
		// A re-add reusing the tombstoned id does NOT resurrect it, even with a strictly newer stamp.
		r = addDevice(r, device("phone", 300));
		expect(ids(r)).toEqual([]);
		// Re-adding the device under a fresh id brings it back (that is how a removed device returns).
		r = addDevice(r, device("phone-2", 400));
		expect(ids(r)).toEqual(["phone-2"]);
	});
});

describe("mayEnroll (a joiner's id is bound to the key it proved)", () => {
	const roster = revokeDevice(
		addDevice(addDevice(emptyRoster(), device("laptop", 100)), device("old", 50)),
		"old",
		hlc(150, "laptop"),
	);

	it("accepts a fresh id", () => {
		expect(mayEnroll(roster, device("phone", 200))).toBe(true);
	});

	it("accepts a device re-presenting its own id and key", () => {
		expect(mayEnroll(roster, device("laptop", 200))).toBe(true);
	});

	it("refuses a member's id under another key, which would evict that member", () => {
		const seize = { ...device("laptop", 200), publicKey: "pk-attacker" };
		expect(mayEnroll(roster, seize)).toBe(false);
		expect(findDevice(addDevice(roster, seize), "laptop")?.publicKey).toBe("pk-attacker");
	});

	it("refuses a revoked id", () => {
		expect(mayEnroll(roster, device("old", 200))).toBe(false);
	});
});

describe("roster merge", () => {
	it("converges regardless of order", () => {
		const a = addDevice(addDevice(emptyRoster(), device("laptop", 100)), device("phone", 150));
		const b = revokeDevice(addDevice(emptyRoster(), device("tablet", 120)), "phone", hlc(300, "x"));
		expect(ids(mergeRosters(a, b))).toEqual(ids(mergeRosters(b, a)));
		// phone revoked at 300 > added at 150; laptop + tablet remain.
		expect(ids(mergeRosters(a, b))).toEqual(["laptop", "tablet"]);
	});
});

describe("roster codec", () => {
	it("round-trips", () => {
		let r = addDevice(emptyRoster(), device("laptop", 100));
		r = revokeDevice(r, "old", hlc(50, "x"));
		expect(decodeRoster(encodeRoster(r))).toEqual(r);
	});

	it("rejects a malformed roster", () => {
		expect(() => decodeRoster(JSON.stringify({ devices: [{ id: "x" }], revoked: [] }))).toThrow();
		expect(() => decodeRoster(JSON.stringify([]))).toThrow();
	});
});

describe("remote-roster future-stamp guard (revocation integrity)", () => {
	const now = 1_000_000; // "current" wall the ingest guard evaluates against
	const futureWall = now + HLC_MAX_DRIFT_MS + 60_000; // implausibly far ahead
	const evilFutureAdd: RosterPayload = {
		devices: [
			{
				id: "evil",
				publicKey: "pk-evil",
				label: "evil",
				addedAt: 100,
				hlc: hlc(futureWall, "evil"),
			},
		],
		revoked: [],
	};

	it("sanitizeRemoteRoster drops future-dated devices and tombstones, keeps present ones", () => {
		const roster: RosterPayload = {
			devices: [device("ok", now), evilFutureAdd.devices[0]!],
			revoked: [{ id: "gone", hlc: hlc(futureWall, "evil") }],
		};
		const safe = sanitizeRemoteRoster(roster, now);
		expect(safe.devices.map((d) => d.id)).toEqual(["ok"]);
		expect(safe.revoked).toEqual([]);
	});

	it("a revoked device cannot re-arm itself with a future-dated roster gossip", () => {
		// evil is legitimately enrolled at t=100, then revoked at t=200.
		let local = addDevice(emptyRoster(), device("evil", 100));
		local = revokeDevice(local, "evil", hlc(200, "me"));
		expect(isActiveDevice(local, "evil")).toBe(false);
		// evil gossips a roster re-adding itself stamped years in the future.
		local = mergeRemoteRoster(local, evilFutureAdd, now);
		expect(isActiveDevice(local, "evil")).toBe(false); // guard holds: stays revoked
	});

	it("sticky tombstone keeps a revoked id dead even in a plain (unsanitized) merge (B1)", () => {
		let local = addDevice(emptyRoster(), device("evil", 100));
		local = revokeDevice(local, "evil", hlc(200, "me"));
		// Even a future-stamped re-add merged WITHOUT the future-stamp guard cannot resurrect evil:
		// roster liveness is sticky, so the tombstone dominates regardless of the record's stamp.
		const unguarded = mergeRosters(local, evilFutureAdd);
		expect(isActiveDevice(unguarded, "evil")).toBe(false);
	});

	it("keeps a normally-stamped remote device", () => {
		const merged = mergeRemoteRoster(
			emptyRoster(),
			{ devices: [device("phone", now)], revoked: [] },
			now,
		);
		expect(isActiveDevice(merged, "phone")).toBe(true);
	});
});

describe("activeSigKeys", () => {
	it("skips revoked, unkeyed and non-canonical keys, once each", () => {
		const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
		const keyed = { ...device("laptop", 1), sigKey: key(1) };
		const twin = { ...device("tablet", 1), sigKey: key(1) };
		const unkeyed = device("phone", 1);
		const gone = { ...device("old", 1), sigKey: key(2) };
		const respelled = { ...device("odd", 1), sigKey: `${key(3).slice(0, 42)}B=` };
		const roster = revokeDevice(
			{ devices: [keyed, twin, unkeyed, gone, respelled], revoked: [] },
			"old",
			hlc(2, "laptop"),
		);
		expect(activeSigKeys(roster)).toEqual([key(1)]);
	});
});

describe("revocation by key", () => {
	const phone = { ...device("phone", 1), sigKey: "P" };
	// Planted before the revocation under a new id, with the same signing key.
	const ghost = { ...device("ghost", 1), sigKey: "P" };
	const laptop = device("laptop", 1);
	const revoked = () =>
		revokeDevice({ devices: [laptop, phone, ghost], revoked: [] }, "phone", hlc(5, "laptop"));

	it("revoking a device revokes its keys", () => {
		const roster = revoked();
		expect(ids(roster)).toEqual(["laptop"]);
		expect(roster.revokedKeys).toEqual(["P", "pk-phone"]);
		const sameChannelKey = { ...device("other", 1), publicKey: "pk-phone" };
		expect(ids(mergeRosters(roster, { devices: [sameChannelKey], revoked: [] }))).toEqual([
			"laptop",
		]);
	});

	it("a remote roster can't bring a revoked key back under a new id", () => {
		const late = { ...device("ghost2", 9), sigKey: "P" };
		const merged = mergeRemoteRoster(revoked(), { devices: [late], revoked: [] });
		expect(activeSigKeys(merged)).not.toContain("P");
		expect(ids(merged)).toEqual(["laptop"]);
	});

	it("a device re-added with an admission is active again, with its old key", () => {
		const back = { ...device("phone-2", 9), sigKey: "P", admission: { by: "laptop", sig: "s" } };
		expect(ids(addDevice(revoked(), back))).toEqual(["laptop", "phone-2"]);
	});

	it("revoked keys survive a merge with a roster that lacks them", () => {
		const plain: RosterPayload = { devices: [laptop], revoked: [] };
		expect(mergeRosters(revoked(), plain).revokedKeys).toEqual(["P", "pk-phone"]);
		expect(mergeRosters(plain, revoked()).revokedKeys).toEqual(["P", "pk-phone"]);
	});

	it("a roster with nothing revoked by key encodes as before", () => {
		const merged = mergeRosters(
			{ devices: [laptop], revoked: [] },
			{ devices: [phone], revoked: [] },
		);
		expect(JSON.parse(encodeRoster(merged))).not.toHaveProperty("revokedKeys");
	});

	it("verifyRemoteRoster passes revoked keys through", () => {
		const remote = revoked();
		const out = verifyRemoteRoster(
			emptyRoster(),
			remote,
			() => true,
			() => true,
		);
		expect(out.revokedKeys).toEqual(["P", "pk-phone"]);
	});
});

describe("admissions on known devices", () => {
	const alias = { ...device("ghost", 1), sigKey: "P", sig: "s" };
	const forged = { ...alias, hlc: hlc(2, "ghost"), admission: { by: "laptop", sig: "junk" } };

	it("a known device can't attach an admission that doesn't verify", () => {
		const out = verifyRemoteRoster(
			{ devices: [alias], revoked: [] },
			{ devices: [forged], revoked: [] },
			() => true,
			() => false,
		);
		expect(out.devices.map((d) => d.id)).toEqual(["ghost"]);
		expect(out.devices[0]?.admission).toBeUndefined();
	});

	it("a known device's admission that verifies is taken", () => {
		const out = verifyRemoteRoster(
			{ devices: [alias], revoked: [] },
			{ devices: [forged], revoked: [] },
			() => true,
			() => true,
		);
		expect(out.devices[0]?.admission).toEqual({ by: "laptop", sig: "junk" });
	});

	it("a revoked device's alias can't keep its key alive with a made-up admission", () => {
		const phone = { ...device("phone", 1), sigKey: "P", sig: "s" };
		const laptop = device("laptop", 1);
		const local: RosterPayload = { devices: [laptop, phone, alias], revoked: [] };
		const verified = verifyRemoteRoster(
			local,
			{ devices: [forged], revoked: [] },
			() => true,
			() => false,
		);
		const merged = revokeDevice(mergeRemoteRoster(local, verified), "phone", hlc(5, "laptop"));
		expect(ids(merged)).toEqual(["laptop"]);
		expect(activeSigKeys(merged)).not.toContain("P");
	});
});

describe("devices that share keys", () => {
	const phone = { ...device("phone", 1), sigKey: "P" };
	const again = { ...device("phone-2", 3), publicKey: "pk-phone", sigKey: "P" };

	it("a joiner carrying a removed device's key is spotted, whatever it claims", () => {
		const roster = revokeDevice({ devices: [phone], revoked: [] }, "phone", hlc(2, "x"));
		expect(carriesRevokedKey(roster, again)).toBe(true);
		expect(carriesRevokedKey(roster, { ...again, admission: { by: "x", sig: "y" } })).toBe(true);
		expect(carriesRevokedKey(roster, device("tablet", 3))).toBe(false);
	});

	it("removing a device names the others that would go with it", () => {
		const roster = { devices: [phone, again, device("tablet", 1)], revoked: [] };
		expect(alsoRemoved(roster, "phone").map((d) => d.id)).toEqual(["phone-2"]);
		const admitted = { ...again, admission: { by: "laptop", sig: "s" } };
		expect(alsoRemoved({ devices: [phone, admitted], revoked: [] }, "phone")).toEqual([]);
	});
});

describe("devices agree about a re-stamped admitted entry", () => {
	// An admission here is the admitter's key over the entry's canonical form, checked against the
	// verifying device's own roster, as the hosts do.
	const keyed = (
		id: string,
		wall: number,
		pub: string,
		sig: string,
		adm?: string,
	): RosterEntry => ({
		...device(id, wall),
		publicKey: pub,
		sigKey: sig,
		sig: "s",
		...(adm ? { admissionKey: adm } : {}),
	});
	const admit = (entry: RosterEntry, by: RosterEntry): RosterEntry => ({
		...entry,
		admission: { by: by.id, sig: `${by.admissionKey}|${canonicalRosterEntry(entry)}` },
	});
	const verify = (local: RosterPayload, remote: RosterPayload) =>
		verifyRemoteRoster(
			local,
			remote,
			() => true,
			(e) => {
				const by = local.devices.find((d) => d.id === e.admission?.by);
				return (
					!!by?.admissionKey && e.admission?.sig === `${by.admissionKey}|${canonicalRosterEntry(e)}`
				);
			},
		);

	it("removing a stale twin leaves every device agreeing about the live one", () => {
		const laptop = keyed("laptop", 1, "pk-laptop", "sk-laptop", "K");
		const stale = keyed("phoneA", 2, "pk-phone", "sk-phone");
		const live = keyed("phoneB", 10, "pk-phone", "sk-phone");
		// One device holds the admitted copy, another the joiner's own unadmitted one.
		let x: RosterPayload = { devices: [laptop, stale, admit(live, laptop)], revoked: [] };
		let z: RosterPayload = { devices: [laptop, stale, live], revoked: [] };
		// The live phone re-stamps its own entry (an invite publishing its admission key).
		const restamped = { ...live, admissionKey: "KP", hlc: hlc(20, "phoneB") };
		x = mergeRemoteRoster(x, verify(x, { devices: [restamped], revoked: [] }));
		z = mergeRemoteRoster(z, verify(z, { devices: [restamped], revoked: [] }));
		x = revokeDevice(x, "phoneA", hlc(30, "laptop"));
		for (let round = 0; round < 5; round++) {
			z = mergeRemoteRoster(z, verify(z, x));
			x = mergeRemoteRoster(x, verify(x, z));
		}
		expect(ids(x)).toEqual(ids(z));
	});
});

describe("stable admissions", () => {
	const phone = { ...device("phone", 1), sigKey: "P" };

	it("the stable form leaves out the stamp and the admission key", () => {
		const restamped = { ...phone, hlc: hlc(9, "phone"), admissionKey: "AK" };
		expect(canonicalAdmission(restamped)).toBe(canonicalAdmission(phone));
		expect(canonicalAdmission({ ...phone, addedAt: 2 })).not.toBe(canonicalAdmission(phone));
	});

	it("admitEntry signs both forms", async () => {
		const admitted = await admitEntry(phone, "laptop", async (message) => message);
		expect(admitted.admission).toEqual({
			by: "laptop",
			sig: canonicalRosterEntry(phone),
			stableSig: canonicalAdmission(phone),
		});
	});
});

describe("hasSignedEntry", () => {
	const entry = (publicKey: string, sigKey?: string) => ({
		id: publicKey,
		publicKey,
		label: publicKey,
		addedAt: 0,
		hlc: { wall: 0, counter: 0, node: publicKey },
		...(sigKey ? { sigKey, sig: "s" } : {}),
	});

	it("is true only for a signed entry carrying this device's key", () => {
		const rosters = [{ devices: [entry("ME"), entry("PEER", "k")], revoked: [] }];
		expect(hasSignedEntry(rosters, "ME")).toBe(false);
		expect(hasSignedEntry(rosters, "PEER")).toBe(true);
		expect(hasSignedEntry([...rosters, { devices: [entry("ME", "m")], revoked: [] }], "ME")).toBe(
			true,
		);
	});
});
