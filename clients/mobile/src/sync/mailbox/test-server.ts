// Test-only: the mailbox server, in memory on a fake clock, in its own process. Client code never
// imports server code, so tests reach it over HTTP as an app would.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVE = fileURLToPath(
	new URL("../../../../../services/mailbox/src/test/serve.ts", import.meta.url),
);

export interface TestMailbox {
	url: string;
	/** Move the server's clock forward. */
	advance(ms: number): Promise<void>;
	/** Run the retention sweep once. */
	sweep(): Promise<void>;
	setCanPost(value: boolean): Promise<void>;
	/** The account a mailbox belongs to on a hosted test server, or "" for none. */
	accountOf(mailboxId: string): Promise<string>;
	close(): Promise<void>;
}

export function startTestMailbox(
	env: {
		QUOTA_BYTES?: string;
		MAILBOX_TOKEN?: string;
		/** JSON: 25 digits to their status; with it the server is hosted, as the Worker is. */
		ACCOUNTS?: string;
	} = {},
): Promise<TestMailbox> {
	const child = spawn(process.execPath, [SERVE], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "inherit"],
	});
	return new Promise((resolve, reject) => {
		const fail = (err: Error) => {
			clearTimeout(timer);
			child.kill();
			reject(err);
		};
		const timer = setTimeout(() => fail(new Error("the test mailbox did not start")), 10_000);
		child.once("exit", (code) => fail(new Error(`the test mailbox exited with ${code}`)));
		let out = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			out += chunk;
			const url = /mailbox listening on (\S+)/.exec(out)?.[1];
			if (!url) return;
			clearTimeout(timer);
			child.removeAllListeners("exit");
			resolve(handle(child, url));
		});
	});
}

function handle(child: ChildProcess, url: string): TestMailbox {
	const post = async (path: string) => {
		const res = await fetch(`${url}${path}`, { method: "POST" });
		if (!res.ok) throw new Error(`${path} answered ${res.status}`);
	};
	return {
		url,
		advance: (ms) => post(`/__test/advance?ms=${ms}`),
		sweep: () => post("/__test/sweep"),
		setCanPost: (value) => post(`/__test/can-post?value=${value}`),
		accountOf: async (mailboxId) =>
			(await fetch(`${url}/__test/account-of?mailbox=${mailboxId}`)).text(),
		close: () =>
			new Promise((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
			}),
	};
}
