// Which mailbox a vault's group uses (docs/mailbox-service.md, "Clients"): Bramble's hosted one,
// or a server of the user's own. A vault-scoped synced setting, so one device switching it on
// switches on every device it reaches; a device can still opt out for itself.

import { z } from "zod";
import type { SyncedSettings } from "../entries-payload";
import type { MailboxServer } from "./api";
import { AccountStatusResponseSchema, HOSTED_MAILBOX_URL, parseAccountNumber } from "./protocol";

export { HOSTED_MAILBOX_URL };

export const MAILBOX_PREF_KEY = "pref.mailbox";
export const MAILBOX_OFF_PREF_KEY = "pref.mailboxOff";
/** The hosted account's number: its own synced setting, so turning the mailbox on can't erase it. */
export const MAILBOX_ACCOUNT_PREF_KEY = "pref.mailboxAccount";

/** What the server's MAILBOX_TOKEN accepts. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

export const MailboxConfigSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("hosted") }),
	z.object({
		kind: z.literal("custom"),
		url: z.string(),
		token: z.string().regex(TOKEN_RE).optional(),
	}),
]);
export type MailboxConfig = z.infer<typeof MailboxConfigSchema>;

/** A custom server to save, or which field is wrong: the URL must be an http(s) origin. */
export function parseMailboxServer(input: {
	url: string;
	token?: string;
}): { ok: true; config: MailboxConfig } | { ok: false; field: "url" | "token" } {
	let url: URL;
	try {
		url = new URL(input.url.trim());
	} catch {
		return { ok: false, field: "url" };
	}
	const origin =
		/^https?:$/.test(url.protocol) &&
		url.pathname === "/" &&
		!url.search &&
		!url.hash &&
		!url.username &&
		!url.password;
	if (!origin) return { ok: false, field: "url" };
	const token = input.token?.trim();
	if (token && !TOKEN_RE.test(token)) return { ok: false, field: "token" };
	return { ok: true, config: { kind: "custom", url: url.origin, ...(token ? { token } : {}) } };
}

/** The group's mailbox choice and account number, as its vault's synced settings hold them. */
export interface MailboxSettings {
	config: MailboxConfig | null;
	account: string | null;
}

/** Each setting parsed on its own, so an unusable one reads as none and spoils nothing else. */
export function readMailboxSettings(settings: SyncedSettings | undefined): MailboxSettings {
	const config = MailboxConfigSchema.safeParse(settings?.[MAILBOX_PREF_KEY]?.value);
	const account = settings?.[MAILBOX_ACCOUNT_PREF_KEY]?.value;
	return {
		config: config.success ? config.data : null,
		account: typeof account === "string" ? parseAccountNumber(account) : null,
	};
}

/** Where the settings point; null for none, or for the hosted mailbox while it is off here. Only
 * the hosted mailbox is ever sent the account number. */
export function mailboxServer(settings: MailboxSettings, hosted: boolean): MailboxServer | null {
	const { config, account } = settings;
	if (!config) return null;
	if (config.kind === "hosted") {
		return hosted ? { url: HOSTED_MAILBOX_URL, ...(account ? { account } : {}) } : null;
	}
	return { url: config.url, ...(config.token ? { token: config.token } : {}) };
}

export const mailboxStateKey = (vaultId: string, mailboxId: string) =>
	`mailbox.state:${vaultId}:${mailboxId}`;
export const mailboxStatusKey = (vaultId: string) => `mailbox.status:${vaultId}`;

export const MailboxStatusRecordSchema = z.object({
	status: z.enum([
		"synced",
		"waiting",
		"retry",
		"collect_only",
		"quota_exceeded",
		"account_required",
		"account_unknown",
		"other_vault",
		"off",
	]),
	at: z.int(),
	/** The hosted account's last known status, when the group has a number. `key` is the
	 * accountKeyOf the number it was read for, so it is never shown under another. */
	account: z
		.union([
			AccountStatusResponseSchema.extend({ at: z.int(), key: z.string().optional() }),
			z.object({ unknown: z.literal(true), at: z.int(), key: z.string().optional() }),
		])
		.optional(),
});
export type MailboxStatusRecord = z.infer<typeof MailboxStatusRecordSchema>;
export type AccountRecord = NonNullable<MailboxStatusRecord["account"]>;
