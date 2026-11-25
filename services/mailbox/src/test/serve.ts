// Test-only: the in-memory server on a fake clock, for client tests in other packages. They spawn
// it as a process, since nothing outside services/ imports server code. The /__test routes exist
// only here: they move the clock, run the sweep and switch posting off.

import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mailboxes } from "../core/schema.ts";
import { sweep } from "../core/sweep.ts";
import { makeServer, type ServerOpts } from "./memory.ts";

const opts: ServerOpts = {
	quotaBytes: process.env.QUOTA_BYTES ? Number(process.env.QUOTA_BYTES) : undefined,
	token: process.env.MAILBOX_TOKEN || undefined,
	accounts: process.env.ACCOUNTS ? JSON.parse(process.env.ACCOUNTS) : undefined,
};
const { app, deps, clock } = makeServer(opts);

const root = new Hono();
root.post("/__test/advance", (c) => {
	clock.now += Number(c.req.query("ms"));
	return c.body(null, 204);
});
root.post("/__test/sweep", async (c) => {
	await sweep(deps);
	return c.body(null, 204);
});
root.post("/__test/can-post", (c) => {
	opts.canPost = c.req.query("value") === "true";
	return c.body(null, 204);
});
root.get("/__test/now", (c) => c.text(String(clock.now)));
root.get("/__test/account-of", async (c) => {
	const row = await deps.db
		.select({ accountId: mailboxes.accountId })
		.from(mailboxes)
		.where(eq(mailboxes.id, c.req.query("mailbox") ?? ""))
		.get();
	return c.text(row?.accountId ?? "");
});
root.route("/", app);

const server = serve({ fetch: root.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
	console.log(`mailbox listening on http://127.0.0.1:${info.port}`);
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
