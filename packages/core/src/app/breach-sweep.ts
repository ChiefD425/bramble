import type { BreachResult, BreachStatus, Entry, LoginEntry } from "../hooks/useVault";
import { isBreachCheckDue } from "../util/pwned";

/** Checks in flight at once. */
export const SWEEP_CONCURRENCY = 4;
/** Results per vault write. Each write re-seals every entry, so one per check would churn a big vault. */
export const SWEEP_SAVE_EVERY = 20;

/** Live logins with a password whose breach result is missing or over a week old. */
export function dueForBreachCheck(entries: readonly Entry[], now: number): LoginEntry[] {
	return entries.filter(
		(e): e is LoginEntry =>
			e.type === "login" &&
			e.archivedAt === undefined &&
			e.password.length > 0 &&
			isBreachCheckDue(e.breach, now),
	);
}

/** One unlocked session's sweep. Locking, switching vaults or turning checks off cancels it. */
export interface BreachSweep {
	/** Ids checked this session, so a result that could not be saved is not retried in a loop. */
	tried: Set<string>;
	running: boolean;
	/** A check or a save failed (offline, HIBP down); the rest wait for the next session. */
	halted: boolean;
	cancelled: boolean;
}

export function newBreachSweep(): BreachSweep {
	return { tried: new Set(), running: false, halted: false, cancelled: false };
}

export interface BreachSweepDeps {
	/** Read fresh each round, so logins added or edited during a pass are seen. */
	due(): LoginEntry[];
	check(password: string): Promise<BreachStatus | undefined>;
	save(results: BreachResult[]): Promise<void>;
}

/** Check every due login not yet tried, a few at a time. No-op while a pass runs or after a halt. */
export async function sweepBreaches(sweep: BreachSweep, deps: BreachSweepDeps): Promise<void> {
	if (sweep.running || sweep.halted || sweep.cancelled) return;
	sweep.running = true;
	let pending: BreachResult[] = [];
	const flush = async () => {
		if (pending.length === 0 || sweep.cancelled) return;
		const batch = pending;
		pending = [];
		await deps.save(batch);
	};
	try {
		while (!sweep.cancelled) {
			const next = deps
				.due()
				.filter((e) => !sweep.tried.has(e.id))
				.slice(0, SWEEP_CONCURRENCY);
			if (next.length === 0) {
				// Nothing left to save means nothing came due while this pass ran, and no await lies
				// between here and `running` clearing, so a login arriving now starts the next pass.
				if (pending.length === 0) break;
				await flush();
				continue;
			}
			for (const e of next) sweep.tried.add(e.id);
			const results = await Promise.all(
				next.map(async ({ id, password }) => {
					const breach = await deps.check(password);
					return breach && { id, password, breach };
				}),
			);
			const ok = results.filter((r) => r !== undefined);
			pending.push(...ok);
			if (ok.length < next.length) {
				sweep.halted = true;
				await flush();
				break;
			}
			if (pending.length >= SWEEP_SAVE_EVERY) await flush();
		}
	} catch {
		sweep.halted = true;
	} finally {
		sweep.running = false;
	}
}
