import type { PendingNewLogin } from "../adapters/shell";
import type { Entry, LoginEntryData } from "../hooks/useVault";
import { extractHostname } from "./autofill-index";

export interface PendingLoginPlan {
	/** Logins to add, each with the queue key to remove once it is saved. */
	add: { key: string; data: LoginEntryData }[];
	/** Queue keys already in the vault: an earlier drain saved them but stopped before removing them. */
	done: string[];
}

function sameLogin(
	a: { username: string; password: string },
	b: { username: string; password: string },
) {
	return a.password !== "" && a.password === b.password && a.username === b.username;
}

/** What to do with the logins the autofill picker queued. */
export function planPendingLogins(entries: Entry[], pending: PendingNewLogin[]): PendingLoginPlan {
	const plan: PendingLoginPlan = { add: [], done: [] };
	for (const p of pending) {
		const saved =
			entries.some((e) => e.type === "login" && sameLogin(e, p)) ||
			plan.add.some((a) => sameLogin(a.data, p));
		if (saved) {
			plan.done.push(p.key);
			continue;
		}
		const url = p.url.trim();
		const name = p.name.trim() || (url ? extractHostname(url) : "") || p.username;
		plan.add.push({
			key: p.key,
			data: {
				type: "login",
				name,
				urls: url ? [url] : [],
				username: p.username,
				password: p.password,
			},
		});
	}
	return plan;
}
