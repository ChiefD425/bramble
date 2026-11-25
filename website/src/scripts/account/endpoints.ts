// Where the account page sends its calls. PUBLIC_BILLING_URL and PUBLIC_MAILBOX_URL point a local
// run at Workers under `wrangler dev`; deployed, they are unset. Built with `--mode sandbox`, both
// are the sandbox Workers, as the mailbox's are in protocol.ts. A module of its own, not
// consts.ts, which every page's script imports.

import { HOSTED_MAILBOX_URL } from "@vault/core/src/sync/mailbox/protocol.ts";

export const BILLING_URL =
	import.meta.env.PUBLIC_BILLING_URL ||
	(import.meta.env.MODE === "sandbox"
		? "https://billing-sandbox.bramble.sh"
		: "https://billing.bramble.sh");
export const MAILBOX_URL = import.meta.env.PUBLIC_MAILBOX_URL || HOSTED_MAILBOX_URL;
