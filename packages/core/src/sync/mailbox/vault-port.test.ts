import { describe, expect, it } from "vitest";
import { harness } from "../../vault/entry-mutations.harness";
import type { QuarantineRecord } from "../../vault/quarantine";
import type { EncryptedEntry } from "../../vault-format";
import { createVaultSyncPort } from "../apply-remote";
import type { Hlc } from "../hlc";
import type { RosterEntry, RosterPayload } from "../roster";
import { createMailboxVaultPort } from "./vault-port";

const hlc = (wall: number, node = "remote"): Hlc => ({ wall, counter: 0, node });
const env = (id: string, ciphertext: string, stamp = hlc(1)): EncryptedEntry => ({
	id,
	wrappedDek: "w",
	dekIv: "d",
	ciphertext,
	iv: "i",
	hlc: stamp,
});
const device = (id: string): RosterEntry => ({
	id,
	publicKey: `pk-${id}`,
	label: id,
	addedAt: 1,
	hlc: hlc(1, id),
});

function setup(opts: { verify?: (json: string) => Promise<string | null> } = {}) {
	const h = harness();
	let roster: RosterPayload = { devices: [device("laptop")], revoked: [] };
	let quarantine: string | null = null;
	const current = { value: true };
	const port = createMailboxVaultPort({
		sync: createVaultSyncPort({
			store: h.mutations,
			crypto: h.crypto,
			witnessRemote: async (stamps) => {
				for (const s of stamps) h.clock.witness(s);
			},
		}),
		rejected: new Set(),
		readEntries: () => h.mutations.readEntriesPayload(),
		readRoster: async () => roster,
		writeRoster: async (next) => {
			roster = next;
		},
		verifyRoster: opts.verify ?? (async (json) => json),
		quarantine: {
			readQuarantine: async () => quarantine,
			writeQuarantine: async (json: string) => {
				quarantine = json;
			},
		},
		vaultId: "v",
		current: () => current.value,
	});
	return {
		port,
		current,
		roster: () => roster,
		vaultIds: async () => (await h.mutations.readEntriesPayload()).entries.map((e) => e.id),
		quarantined: () => (quarantine === null ? [] : (JSON.parse(quarantine) as QuarantineRecord[])),
	};
}

const remoteRoster = (): RosterPayload => ({
	devices: [device("laptop"), device("phone")],
	revoked: [],
});

describe("mailbox vault port", () => {
	it("merges entries and roster and reports a refusal, quarantining it", async () => {
		const s = setup();
		const stray = env("stray", "x:not this vault's");
		const applied = await s.port.apply({
			entries: { entries: [env("good", "ct:{}"), stray], tombstones: [] },
			roster: remoteRoster(),
		});
		expect(applied).toEqual({ setAside: false, refused: [stray] });
		expect(await s.vaultIds()).toEqual(["good"]);
		expect(s.quarantined()).toEqual([expect.objectContaining({ id: "stray" })]);
		expect(
			s
				.roster()
				.devices.map((d) => d.id)
				.sort(),
		).toEqual(["laptop", "phone"]);
	});

	it("reports a future-dated entry as set aside", async () => {
		const s = setup();
		const ahead = env("later", "ct:{}", hlc(Date.now() + 3_600_000));
		const applied = await s.port.apply({
			entries: { entries: [ahead], tombstones: [] },
			roster: remoteRoster(),
		});
		expect(applied?.setAside).toBe(true);
		expect(await s.vaultIds()).toEqual([]);
	});

	it("returns null and writes nothing once the vault is no longer current", async () => {
		const s = setup();
		s.current.value = false;
		const applied = await s.port.apply({
			entries: { entries: [env("good", "ct:{}")], tombstones: [] },
			roster: remoteRoster(),
		});
		expect(applied).toBeNull();
		expect(await s.vaultIds()).toEqual([]);
		expect(s.roster().devices.map((d) => d.id)).toEqual(["laptop"]);
	});

	it("previews a roster with a verified new device, without writing it", async () => {
		const s = setup();
		const preview = await s.port.previewRoster(remoteRoster());
		expect(preview.devices.map((d) => d.id).sort()).toEqual(["laptop", "phone"]);
		expect(s.roster().devices.map((d) => d.id)).toEqual(["laptop"]);
	});

	it("ignores a roster that verification refuses", async () => {
		const s = setup({ verify: async () => null });
		await s.port.apply({
			entries: { entries: [env("good", "ct:{}")], tombstones: [] },
			roster: remoteRoster(),
		});
		expect(s.roster().devices.map((d) => d.id)).toEqual(["laptop"]);
		expect(await s.vaultIds()).toEqual(["good"]);
		expect((await s.port.previewRoster(remoteRoster())).devices).toHaveLength(1);
	});
});
