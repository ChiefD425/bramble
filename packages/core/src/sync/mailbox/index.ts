// The mailbox client's public surface: what a platform needs to wire the engine (Plan 4).

export {
	type MailboxApi,
	MailboxApiError,
	type MailboxBlobMover,
	type MailboxServer,
	type MailboxSigner,
	mailboxApi,
	type SignedRequest,
	storeBlobMover,
} from "./api";
export {
	type AccountRecord,
	HOSTED_MAILBOX_URL,
	MAILBOX_ACCOUNT_PREF_KEY,
	MAILBOX_OFF_PREF_KEY,
	MAILBOX_PREF_KEY,
	type MailboxConfig,
	MailboxConfigSchema,
	type MailboxSettings,
	type MailboxStatusRecord,
	MailboxStatusRecordSchema,
	mailboxServer,
	mailboxStateKey,
	mailboxStatusKey,
	parseMailboxServer,
	readMailboxSettings,
} from "./config";
export type { MailboxContext } from "./context";
export {
	createMailboxDriver,
	MAILBOX_ALARM,
	type MailboxDriver,
	type MailboxDriverDeps,
	type MailboxEngine,
} from "./driver";
export type { MailboxCryptoPort } from "./envelope";
export {
	createInProcessMailbox,
	type InProcessMailbox,
	type InProcessMailboxPlatform,
} from "./in-process";
export type { MembersResponse } from "./protocol";
export { type MailboxState, type MailboxStateStore, metaStateStore } from "./state";
export { type MailboxStatus, type MailboxSync, mailboxSync } from "./sync";
export {
	createMailboxVaultPort,
	type MailboxApplied,
	type MailboxEnvelope,
	type MailboxVaultPort,
} from "./vault-port";
