// When a client runs a mailbox round (docs/mailbox-service.md, "Clients"): on unlock, after a
// local change, on a timer, and on "Sync now", for the unlocked active vault only. Rounds never
// overlap; a trigger during one queues one more. Free of any platform, so each client wires it.

import { type MailboxApi, MailboxApiError, type MailboxServer } from "./api";
import {
	type AccountRecord,
	type MailboxSettings,
	type MailboxStatusRecord,
	mailboxServer,
} from "./config";
import { accountKeyOf, type MembersResponse } from "./protocol";
import type { MailboxSync } from "./sync";

export const MAILBOX_ALARM = "mailbox:sync";
const ALARM_MINUTES = 5;
const CHANGE_QUIET_MS = 3000;
/** How stale the account's paid time and storage may get before a round asks again. */
export const ACCOUNT_CHECK_MS = 300_000;

type Status = MailboxStatusRecord["status"];

export interface MailboxEngine {
	sync: MailboxSync;
	api: MailboxApi;
}

export interface MailboxDriverDeps {
	build(
		vaultId: string,
		server: MailboxServer,
		current: () => boolean,
	): Promise<MailboxEngine | null>;
	/** The group and roster key an engine speaks for, or null with neither: see mailboxIdentity. */
	identity(vaultId: string): Promise<string | null>;
	/** The vault's synced mailbox settings, from its decrypted payload: see readMailboxSettings. */
	readSettings(vaultId: string): Promise<MailboxSettings>;
	offHere(vaultId: string): Promise<boolean>;
	writeStatus(vaultId: string, record: MailboxStatusRecord): Promise<void>;
	alarms: { create(name: string, periodInMinutes: number): void; clear(name: string): void };
	/** Firefox: keep the event page up while a round runs. */
	keepAlive<T>(run: () => Promise<T>): Promise<T>;
	now(): number;
	/** Whether Bramble's hosted mailbox is on for this target. */
	hosted: boolean;
	/**
	 * Where one signing key serves every vault (mobile, desktop): the vault it is active for.
	 * `claim` answers false while another vault holds it. Absent where each vault has its own key.
	 */
	keyHome?: { claim(vaultId: string): Promise<boolean>; release(vaultId: string): Promise<void> };
}

export interface MailboxDriver {
	/** The unlocked, opened active vault, or null on lock. */
	retarget(vaultId: string | null): void;
	/** A local change: one round after 3 s of quiet. */
	changed(): void;
	alarm(): Promise<void>;
	syncNow(): Promise<Status>;
	members(): Promise<MembersResponse["members"] | null>;
	/** For the vault port: is this vault still the one to judge messages for? */
	current(vaultId: string): boolean;
}

export function createMailboxDriver(deps: MailboxDriverDeps): MailboxDriver {
	let target: string | null = null;
	let engine: { key: string; identity: string; built: MailboxEngine } | null = null;
	/** The engine key this device already switched off for, so it deactivates once. */
	let switchedOff: string | null = null;
	let running: Promise<Status> | null = null;
	let again = false;
	let quiet: ReturnType<typeof setTimeout> | null = null;

	/** The last account status, for one vault and number: never shown under another. */
	let account: { vaultId: string; number: string; record: AccountRecord } | null = null;

	const current = (vaultId: string) => target === vaultId;

	async function record(vaultId: string, status: Status): Promise<Status> {
		const known = account?.vaultId === vaultId ? account.record : undefined;
		await deps.writeStatus(vaultId, {
			status,
			at: deps.now(),
			...(known ? { account: known } : {}),
		});
		return status;
	}

	/** Ask after the account when its record is missing or stale; a failed ask keeps the last. */
	async function checkAccount(vaultId: string, number: string, api: MailboxApi): Promise<void> {
		if (account && deps.now() - account.record.at < ACCOUNT_CHECK_MS) return;
		const key = await accountKeyOf(number);
		try {
			const status = await api.accountStatus();
			account = { vaultId, number, record: { ...status, at: deps.now(), key } };
		} catch (err) {
			if (err instanceof MailboxApiError && err.code === "account_unknown") {
				account = { vaultId, number, record: { unknown: true, at: deps.now(), key } };
			} else {
				console.warn(
					"[mailbox] could not read the account's status; the next round asks again:",
					err,
				);
			}
		}
	}

	/** One more round on an engine being let go, so the change that retires it reaches devices
	 * only the old server connects: a new server, or "stop". */
	async function lastRound(built: MailboxEngine): Promise<void> {
		try {
			await deps.keepAlive(() => built.sync.sync());
		} catch (err) {
			console.warn("[mailbox] the last round on the old server failed:", err);
		}
	}

	/** Tell the mailbox of a group this device left that it's gone, once; a failure is only logged. */
	async function retire(built: MailboxEngine): Promise<void> {
		try {
			await deps.keepAlive(() => built.sync.switchOff());
		} catch (err) {
			console.warn("[mailbox] could not deactivate in the old mailbox:", err);
		}
	}

	async function round(): Promise<Status> {
		const vaultId = target;
		if (!vaultId) return "off";
		const identity = await deps.identity(vaultId);
		if (!current(vaultId)) return "off";
		// Left the group, or joined another: the old engine must never run a round again, or it would
		// reconcile the old mailbox against a roster that is not its own. It only switches off there,
		// so the server doesn't keep this key active in two mailboxes.
		if (engine && engine.identity !== identity) {
			const retired = engine.built;
			engine = null;
			await retire(retired);
		}
		if (!identity) {
			deps.alarms.clear(MAILBOX_ALARM);
			await deps.keyHome?.release(vaultId);
			return record(vaultId, "waiting");
		}
		const server = mailboxServer(await deps.readSettings(vaultId), deps.hosted);
		const key = server ? `${server.url}|${server.token ?? ""}|${server.account ?? ""}` : null;
		// Another vault's or another number's figures are never shown under this one.
		if (account && (account.vaultId !== vaultId || account.number !== server?.account)) {
			account = null;
		}
		if (engine && engine.key !== key) {
			const retired = engine.built;
			engine = null;
			await lastRound(retired);
		}
		if (!server || !key) {
			deps.alarms.clear(MAILBOX_ALARM);
			await deps.keyHome?.release(vaultId);
			return record(vaultId, "off");
		}
		const offHere = await deps.offHere(vaultId);
		// A shared key active in two mailboxes would let the server link them (docs/mailbox-service.md,
		// "Keys and identity"); a device that opted out here only switches off, so it claims nothing.
		if (deps.keyHome && !offHere && !(await deps.keyHome.claim(vaultId))) {
			deps.alarms.clear(MAILBOX_ALARM);
			return record(vaultId, "other_vault");
		}
		if (!engine) {
			const built = await deps.build(vaultId, server, () => current(vaultId));
			if (!current(vaultId)) return "off";
			if (!built) {
				deps.alarms.clear(MAILBOX_ALARM);
				return record(vaultId, "waiting");
			}
			engine = { key, identity, built };
		}
		const live = engine.built;
		if (offHere) {
			deps.alarms.clear(MAILBOX_ALARM);
			if (switchedOff !== key) {
				try {
					await live.sync.switchOff();
					switchedOff = key;
					await deps.keyHome?.release(vaultId);
				} catch (err) {
					// Off is this device's choice either way; the next trigger tries to tell the server.
					console.warn("[mailbox] could not deactivate on the server yet:", err);
				}
			}
			return record(vaultId, "off");
		}
		switchedOff = null;
		deps.alarms.create(MAILBOX_ALARM, ALARM_MINUTES);
		const status = await deps.keepAlive(() => live.sync.sync());
		if (server.account) await checkAccount(vaultId, server.account, live.api);
		return record(vaultId, status);
	}

	async function safeRound(): Promise<Status> {
		try {
			return await round();
		} catch (err) {
			console.warn("[mailbox] a round failed; the next trigger retries:", err);
			return target ? record(target, "retry").catch(() => "retry" as const) : "off";
		}
	}

	function run(): Promise<Status> {
		if (running) {
			again = true;
			return running;
		}
		running = (async () => {
			try {
				let status = await safeRound();
				while (again) {
					again = false;
					status = await safeRound();
				}
				return status;
			} finally {
				running = null;
			}
		})();
		return running;
	}

	return {
		retarget(vaultId) {
			if (vaultId === target) return;
			target = vaultId;
			engine = null;
			switchedOff = null;
			if (quiet) clearTimeout(quiet);
			quiet = null;
			if (!vaultId) {
				deps.alarms.clear(MAILBOX_ALARM);
				return;
			}
			void run();
		},
		changed() {
			if (!target) return;
			if (quiet) clearTimeout(quiet);
			quiet = setTimeout(() => {
				quiet = null;
				void run();
			}, CHANGE_QUIET_MS);
		},
		async alarm() {
			if (!target) return;
			// The round it runs now covers a change still waiting for its quiet window.
			if (quiet) clearTimeout(quiet);
			quiet = null;
			await run();
		},
		syncNow: () => (target ? run() : Promise.resolve("off" as const)),
		async members() {
			if (!engine) return null;
			try {
				return (await engine.built.api.members()).members;
			} catch {
				return null;
			}
		},
		current,
	};
}
