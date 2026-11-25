// Membership mirrors the roster (docs/mailbox-service.md, "Eligibility mirrors the roster"). The
// first device creates the mailbox listing every active roster device; the others activate and
// ask for a catch-up. Reconciling removes every listed key the roster does not hold, which also
// undoes a replayed `add` (Plan 1's open item 4).

import { activeSigKeys, type RosterPayload } from "../roster";
import { MailboxApiError } from "./api";
import { limit, type MailboxContext } from "./context";
import { accountKeyOf, MAX_MEMBERS } from "./protocol";
import type { MailboxState } from "./state";

const desired = (ctx: MailboxContext, roster: RosterPayload) =>
	[...new Set([...activeSigKeys(roster), ctx.sigKey])].sort();

const is = (err: unknown, code: string) => err instanceof MailboxApiError && err.code === code;

/** Activate this device, creating the mailbox if nobody has. "waiting": no member listed it yet. */
export async function ensureActive(
	ctx: MailboxContext,
	state: MailboxState,
	roster: RosterPayload,
): Promise<"active" | "waiting"> {
	if (state.active) return "active";
	try {
		await ctx.api.activate(true);
	} catch (err) {
		if (is(err, "not_eligible")) return "waiting";
		if (!is(err, "not_found")) throw err;
		try {
			await ctx.api.create({ members: desired(ctx, roster) });
			// Nobody else is active yet, so there is nobody to ask for a catch-up.
			state.active = true;
			state.account = ctx.api.account ? await accountKeyOf(ctx.api.account) : null;
			return "active";
		} catch (createErr) {
			if (!is(createErr, "exists")) throw createErr;
			try {
				await ctx.api.activate(true);
			} catch (again) {
				if (is(again, "not_eligible")) return "waiting";
				throw again;
			}
		}
	}
	state.active = true;
	state.catchUp = true;
	return "active";
}

/** Move the mailbox to the group's account when its number changed. "unknown" if the hosted
 * service doesn't know the number, "full" if that account holds all the mailboxes it may: the
 * mailbox stays where it was either way. */
export async function ensureAccount(
	ctx: MailboxContext,
	state: MailboxState,
): Promise<"ok" | "unknown" | "full"> {
	const number = ctx.api.account;
	if (!number || !state.active) return "ok";
	const key = await accountKeyOf(number);
	if (state.account === key) return "ok";
	try {
		await ctx.api.attach();
	} catch (err) {
		if (is(err, "account_unknown")) return "unknown";
		if (is(err, "quota_exceeded")) return "full";
		throw err;
	}
	state.account = key;
	return "ok";
}

/** Whether the roster changed since the last reconcile, or a day has passed. */
function due(ctx: MailboxContext, state: MailboxState, want: string[]): boolean {
	const last = state.reconciled;
	return !(last?.roster === want.join(",") && ctx.now() - last.at < limit(ctx, "reconcileEveryMs"));
}

/**
 * Remove listed keys the roster no longer holds, before this round posts anything, so a device
 * revoked here is sent nothing more. Additions wait for reconcileMembers, after the post that
 * carries the roster naming them.
 */
export async function pruneMembers(
	ctx: MailboxContext,
	state: MailboxState,
	roster: RosterPayload,
): Promise<void> {
	const want = desired(ctx, roster);
	if (!due(ctx, state, want)) return;
	const remove = (await ctx.api.members()).members
		.map((m) => m.sigKey)
		.filter((k) => !want.includes(k));
	for (let i = 0; i < remove.length; i += MAX_MEMBERS) {
		await ctx.api.changeMembers({ add: [], remove: remove.slice(i, i + MAX_MEMBERS) });
	}
}

export async function reconcileMembers(
	ctx: MailboxContext,
	state: MailboxState,
	roster: RosterPayload,
): Promise<void> {
	const want = desired(ctx, roster);
	if (!due(ctx, state, want)) return;
	const fingerprint = want.join(",");
	const listed = (await ctx.api.members()).members.map((m) => m.sigKey);
	const add = want.filter((k) => !listed.includes(k));
	const remove = listed.filter((k) => !want.includes(k));
	for (let i = 0; i < Math.max(add.length, remove.length); i += MAX_MEMBERS) {
		await ctx.api.changeMembers({
			add: add.slice(i, i + MAX_MEMBERS),
			remove: remove.slice(i, i + MAX_MEMBERS),
		});
	}
	state.reconciled = { roster: fingerprint, at: ctx.now() };
}

/** Stop receiving: this device stays eligible, so switching back on needs nobody's help. */
export async function switchOff(ctx: MailboxContext, state: MailboxState): Promise<void> {
	await ctx.api.activate(false);
	state.active = false;
}
