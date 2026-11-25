/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
	/** A local billing Worker for the account page, e.g. http://localhost:8788. */
	readonly PUBLIC_BILLING_URL?: string;
	/** A local mailbox Worker for the account page's status reads. */
	readonly PUBLIC_MAILBOX_URL?: string;
}
