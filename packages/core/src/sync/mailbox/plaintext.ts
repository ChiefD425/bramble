// What a mailbox message seals (docs/mailbox-service.md, "Messages"). The kind and the sender's
// sequence number live only in here, so the server never sees them.

import { z } from "zod";
import { EntriesPayloadSchema } from "../entries-payload";
import { RosterPayloadSchema } from "../roster";
import { MessageIdSchema, SigKeySchema } from "./protocol";

const Seq = z.int().min(0);

/**
 * Each part of a delta is a delta with its own `seq`. A snapshot's `seq` is the sender's last
 * delta number, which it covers through; `answers` repeats the `of` of the request it answers.
 */
export const MailboxPlaintextSchema = z.discriminatedUnion("kind", [
	z.object({
		v: z.literal(1),
		kind: z.literal("delta"),
		epoch: MessageIdSchema,
		seq: Seq.min(1),
		entries: EntriesPayloadSchema,
		roster: RosterPayloadSchema,
	}),
	z.object({
		v: z.literal(1),
		kind: z.literal("snapshot"),
		epoch: MessageIdSchema,
		seq: Seq,
		part: z.int().min(1),
		parts: z.int().min(1),
		answers: SigKeySchema.nullable(),
		/** For an answer: how far the answerer had the sender it answers for, which is as far as
		 * the answer can heal that sender's gap. */
		covers: z.object({ epoch: MessageIdSchema, through: Seq }).optional(),
		entries: EntriesPayloadSchema,
		roster: RosterPayloadSchema,
	}),
	z.object({ v: z.literal(1), kind: z.literal("snapshot_request"), of: SigKeySchema.nullable() }),
]);
export type MailboxPlaintext = z.infer<typeof MailboxPlaintextSchema>;

const KINDS = new Set(["delta", "snapshot", "snapshot_request"]);

export const encodePlaintext = (m: MailboxPlaintext): string => JSON.stringify(m);

/** `unsupported` is a newer client's message, held until this one updates; `malformed` is not. */
export function decodePlaintext(
	json: string,
): { ok: true; message: MailboxPlaintext } | { ok: false; why: "unsupported" | "malformed" } {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { ok: false, why: "malformed" };
	}
	const { v, kind } = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
		string,
		unknown
	>;
	if ((typeof v === "number" && v !== 1) || (typeof kind === "string" && !KINDS.has(kind))) {
		return { ok: false, why: "unsupported" };
	}
	const parsed = MailboxPlaintextSchema.safeParse(raw);
	return parsed.success ? { ok: true, message: parsed.data } : { ok: false, why: "malformed" };
}
