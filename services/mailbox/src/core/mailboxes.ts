// Creating a mailbox and keeping its membership: eligible members are listed by an active one,
// and only an eligible member can make itself active (docs/mailbox-service.md, "Mailboxes and
// members").

import {
	ActivationBodySchema,
	CreateMailboxBodySchema,
	HEADERS,
	MAX_MEMBERS,
	MailboxIdSchema,
	MembersBodySchema,
	type MembersResponse,
	SettingsBodySchema,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Db, Env } from "./app.ts";
import { HttpError, param, signedJson } from "./auth.ts";
import { dropMember } from "./cleanup.ts";
import { mailboxes, members } from "./schema.ts";
import { chunk, rowsPerInsert } from "./sql.ts";

/** Membership bodies are at most 2 x MAX_MEMBERS keys; this leaves ample room. */
const SMALL_JSON_BYTES = 64 * 1024;

export const mailboxParam = param(z.object({ id: MailboxIdSchema }));

/** Whether this key is a member of the mailbox, eligible or active. */
export async function isMember(db: Db, mailboxId: string, sigKey: string): Promise<boolean> {
	const row = await db
		.select({ one: members.sigKey })
		.from(members)
		.where(and(eq(members.mailboxId, mailboxId), eq(members.sigKey, sigKey)))
		.get();
	return row !== undefined;
}

export async function requireMember(
	deps: AppDeps,
	mailboxId: string,
	sigKey: string,
	need: "any" | "active",
): Promise<{ status: "eligible" | "active"; retentionDays: number }> {
	const mailbox = await deps.db
		.select({ retentionDays: mailboxes.retentionDays })
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.get();
	if (!mailbox) throw new HttpError(404, "not_found");
	const member = await deps.db
		.select({ status: members.status })
		.from(members)
		.where(and(eq(members.mailboxId, mailboxId), eq(members.sigKey, sigKey)))
		.get();
	if (!member) throw new HttpError(403, "not_member");
	if (need === "active" && member.status !== "active") throw new HttpError(403, "not_active");
	return { status: member.status, retentionDays: mailbox.retentionDays };
}

async function listMembers(deps: AppDeps, mailboxId: string): Promise<MembersResponse> {
	const rows = await deps.db
		.select({
			sigKey: members.sigKey,
			status: members.status,
			lastCheckedDay: members.lastCheckedDay,
		})
		.from(members)
		.where(eq(members.mailboxId, mailboxId))
		.orderBy(asc(members.addedAt), asc(members.sigKey));
	return { members: rows };
}

export function mailboxRoutes(deps: AppDeps) {
	const { db } = deps;
	const clamp = (days: number) => Math.min(days, deps.config.retentionMaxDays);
	const r = new Hono<Env>();

	r.post(
		"/:id",
		mailboxParam,
		...signedJson(CreateMailboxBodySchema, SMALL_JSON_BYTES),
		async (c) => {
			const { id } = c.req.valid("param");
			const body = c.req.valid("json");
			const caller = c.var.sigKey;
			if (!body.members.includes(caller)) throw new HttpError(400, "bad_request");
			// Before anything is written: the hosted service refuses a mailbox with no account.
			const accountId = await deps.entitlement.admit(c.req.header(HEADERS.account));
			const now = deps.now();
			const created = await db
				.insert(mailboxes)
				.values({
					id,
					retentionDays: clamp(body.retentionDays ?? deps.config.retentionMaxDays),
					createdAt: now,
					accountId,
				})
				.onConflictDoNothing()
				.returning({ id: mailboxes.id });
			// Over the cap once written: undone, so of creates in flight together only those that fit
			// stay. It has no members yet.
			if (created.length > 0 && accountId && (await deps.entitlement.overMailboxCap?.(accountId))) {
				await db.delete(mailboxes).where(eq(mailboxes.id, id));
				throw new HttpError(507, "quota_exceeded");
			}
			if (created.length === 0) {
				// Ids are fixed per group, so a create that died between its two writes would otherwise
				// lock the group out until the sweep. A mailbox with no members is unclaimed.
				const anyMember = await db
					.select({ sigKey: members.sigKey })
					.from(members)
					.where(eq(members.mailboxId, id))
					.limit(1)
					.get();
				if (anyMember) throw new HttpError(409, "exists");
			}
			const rows = [...new Set(body.members)].map((sigKey) => ({
				mailboxId: id,
				sigKey,
				status: sigKey === caller ? ("active" as const) : ("eligible" as const),
				addedAt: now,
			}));
			for (const part of chunk(rows, rowsPerInsert(4))) {
				await db.insert(members).values(part).onConflictDoNothing();
			}
			return c.json(await listMembers(deps, id));
		},
	);

	r.patch("/:id", mailboxParam, ...signedJson(SettingsBodySchema, SMALL_JSON_BYTES), async (c) => {
		const { id } = c.req.valid("param");
		await requireMember(deps, id, c.var.sigKey, "active");
		await db
			.update(mailboxes)
			.set({ retentionDays: clamp(c.req.valid("json").retentionDays) })
			.where(eq(mailboxes.id, id));
		return c.body(null, 204);
	});

	// Pay for the mailbox from another account (hosted). Its stored bytes count there from now on.
	r.put("/:id/account", mailboxParam, async (c) => {
		const { id } = c.req.valid("param");
		await requireMember(deps, id, c.var.sigKey, "active");
		const accountId = await deps.entitlement.admit(c.req.header(HEADERS.account), id);
		// A self-hosted server has no accounts.
		if (accountId === null) throw new HttpError(404, "not_found");
		const before = await db
			.select({ accountId: mailboxes.accountId })
			.from(mailboxes)
			.where(eq(mailboxes.id, id))
			.get();
		await db.update(mailboxes).set({ accountId }).where(eq(mailboxes.id, id));
		// As for a create: a move that takes the account over its cap goes back where it was.
		if (await deps.entitlement.overMailboxCap?.(accountId)) {
			await db
				.update(mailboxes)
				.set({ accountId: before?.accountId ?? null })
				.where(eq(mailboxes.id, id));
			throw new HttpError(507, "quota_exceeded");
		}
		return c.body(null, 204);
	});

	r.get("/:id/members", mailboxParam, async (c) => {
		const { id } = c.req.valid("param");
		await requireMember(deps, id, c.var.sigKey, "any");
		return c.json(await listMembers(deps, id));
	});

	r.post(
		"/:id/members",
		mailboxParam,
		...signedJson(MembersBodySchema, SMALL_JSON_BYTES),
		async (c) => {
			const { id } = c.req.valid("param");
			await requireMember(deps, id, c.var.sigKey, "active");
			const { add, remove } = c.req.valid("json");
			// Counted as the request leaves it (adds, then removes), so a mailbox never holds more than
			// MAX_MEMBERS and one request can swap members at the cap.
			const present = await db
				.select({ sigKey: members.sigKey })
				.from(members)
				.where(eq(members.mailboxId, id));
			const after = new Set([...present.map((m) => m.sigKey), ...add]);
			for (const sigKey of remove) after.delete(sigKey);
			if (after.size > MAX_MEMBERS) throw new HttpError(413, "too_large");
			const now = deps.now();
			const rows = [...new Set(add)].map((sigKey) => ({
				mailboxId: id,
				sigKey,
				status: "eligible" as const,
				addedAt: now,
			}));
			for (const part of chunk(rows, rowsPerInsert(4))) {
				await db.insert(members).values(part).onConflictDoNothing();
			}
			for (const sigKey of new Set(remove)) await dropMember(deps, id, sigKey, false);
			return c.json(await listMembers(deps, id));
		},
	);

	r.post(
		"/:id/activation",
		mailboxParam,
		...signedJson(ActivationBodySchema, SMALL_JSON_BYTES),
		async (c) => {
			const { id } = c.req.valid("param");
			const caller = c.var.sigKey;
			try {
				await requireMember(deps, id, caller, "any");
			} catch (err) {
				if (err instanceof HttpError && err.code === "not_member")
					throw new HttpError(403, "not_eligible");
				throw err;
			}
			const { active } = c.req.valid("json");
			if (!active) await dropMember(deps, id, caller, true);
			await db
				.update(members)
				.set({ status: active ? "active" : "eligible" })
				.where(and(eq(members.mailboxId, id), eq(members.sigKey, caller)));
			return c.json(await listMembers(deps, id));
		},
	);

	return r;
}
