// The hosted mailbox's Worker: the shared app on each request, and the retention sweep on the
// cron. See docs/mailbox-service.md, "Storage on the hosted service".

import { createApp } from "../core/app.ts";
import { rootMessage } from "../core/errors.ts";
import { sweep } from "../core/sweep.ts";
import { workerDeps } from "./deps.ts";

export { Accounts } from "./rpc.ts";

export default {
	fetch(request, env, ctx) {
		return createApp(workerDeps(env)).fetch(request, env, ctx);
	},
	scheduled(_controller, env, ctx) {
		ctx.waitUntil(
			sweep(workerDeps(env)).then(
				() => {},
				(err: unknown) => {
					console.error(`mailbox sweep failed: ${rootMessage(err)}`);
				},
			),
		);
	},
} satisfies ExportedHandler<Env>;
