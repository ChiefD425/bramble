// The mailbox engine's design calls (docs/mailbox-service.md).
export const LIMITS = {
	/** Payload JSON per message: MAX_MESSAGE_BYTES less the signature, seal header and roster. */
	partBudget: 12 * 1024 * 1024,
	/** Compact once this many of this device's own messages are logged... */
	compactCount: 64,
	/** ...or once they total this many bytes. */
	compactBytes: 4 * 1024 * 1024,
	/** At most one snapshot request per gap sender, and one answer per requester, this often. */
	requestEveryMs: 3_600_000,
	/** A gap the answers didn't reach is asked about again this often. */
	uncoveredRetryMs: 86_400_000,
	reconcileEveryMs: 86_400_000,
	/** Inbox pages one drain reads at most: a server answering "more" forever can't hold a round. */
	drainPages: 20,
	/** New wants fetched directly per sync. */
	directGets: 20,
	/** A message whose merge set something aside is looked at again after this long... */
	heldRetryMs: 3_600_000,
	/** ...and a newer client's message after this long. */
	newerRetryMs: 86_400_000,
} as const;
