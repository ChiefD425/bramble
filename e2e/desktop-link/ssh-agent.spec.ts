import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { DESKTOP_PW, desk, expect, test } from "./fixtures";

// The desktop app as an SSH agent, end to end with OpenSSH's own tools: a key added in the app,
// the agent switched on in Settings, "Add it for me" writing the scratch home's ~/.ssh/config, a
// signature while unlocked with no UI, one after an unlock the request brought up, and Cancel.
// The app runs with a scratch HOME; the real ~/.ssh/config is checked untouched at the end.
test.use({ ownApp: true });

interface Ran {
	code: number;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Ran> {
	return new Promise((resolve) => {
		execFile(cmd, args, { env, timeout: 150_000 }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

/** What the real ~/.ssh/config looks like now: its hash and mtime, or null when there is none. */
function realConfig(): string | null {
	const file = path.join(userInfo().homedir, ".ssh", "config");
	if (!existsSync(file)) return null;
	const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
	return `${hash} ${statSync(file).mtimeMs}`;
}

test("the SSH agent signs for ssh after an unlock, and Cancel refuses", async ({ desktop }) => {
	const before = realConfig();
	const dir = mkdtempSync(path.join(tmpdir(), "bsa-"));
	try {
		const keyFile = path.join(dir, "key");
		expect(
			(await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "e2e", "-f", keyFile])).code,
		).toBe(0);
		const pubLine = readFileSync(`${keyFile}.pub`, "utf8").trim();
		const privateKey = readFileSync(keyFile, "utf8");

		await desk(`
			await front();
			await click(/^Add New$/);
			await click(/^SSH key/);
			await fill("input[name=name]", "Deploy");
			await fill("textarea[name=privateKey]", ${JSON.stringify(privateKey)});
			await fill("textarea[name=hosts]", "localhost");
			await click(/^Save SSH key$/);
			await waitFor(() => text().includes("Deploy"));
		`);
		// From here only the agent holds the private key.
		rmSync(keyFile);

		await desk(`
			await click(/^Settings$/);
			await click(/^General$/);
			await click(/^Toggle SSH agent$/, "[aria-label]");
			await click(/^Add it for me$/);
			await waitFor(() => text().includes("Added to ~/.ssh/config"));
		`);
		const config = readFileSync(path.join(desktop.home, ".ssh", "config"), "utf8");
		expect(config.startsWith("Include ~/.ssh/bramble/config\n")).toBe(true);

		const socket = path.join(
			desktop.home,
			"Library/Application Support/app.bramble.desktop/ssh-agent.sock",
		);
		const env = { ...process.env, SSH_AUTH_SOCK: socket };
		const listed = await run("ssh-add", ["-L"], env);
		expect(listed.stdout).toContain(pubLine.split(" ")[1]);
		expect(listed.stdout).toContain("Deploy");

		const data = path.join(dir, "data");
		writeFileSync(data, "a commit");
		const sign = () =>
			run("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", `${keyFile}.pub`, data], env);
		const fresh = () => rmSync(`${data}.sig`, { force: true });

		// Unlocked: no UI at all.
		const quiet = await sign();
		expect(quiet.code, quiet.stderr).toBe(0);

		// Locked: the unlock screen says who asked; unlocking lets the signature through.
		fresh();
		await desk(`await click(/^Settings$/).catch(() => {}); await click(/^Lock vault$/);`);
		const waiting = sign();
		await desk(`
			await front();
			await waitFor(() => text().includes("wants to sign a git commit with Deploy"), 20000);
			await fillPasswords(${JSON.stringify(DESKTOP_PW)});
			await click(/^Unlock Vault$/);
		`);
		const afterUnlock = await waiting;
		expect(afterUnlock.code, afterUnlock.stderr).toBe(0);
		const allowed = path.join(dir, "allowed");
		writeFileSync(allowed, `e2e ${pubLine}\n`);
		const verify = await new Promise<Ran>((resolve) => {
			const child = execFile(
				"ssh-keygen",
				["-Y", "verify", "-f", allowed, "-I", "e2e", "-n", "git", "-s", `${data}.sig`],
				(error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }),
			);
			child.stdin?.end(readFileSync(data));
		});
		expect(verify.code, verify.stderr).toBe(0);

		// Locked again: Cancel answers no, and ssh-keygen fails.
		fresh();
		await desk(`await front(); await click(/^Lock vault$/);`);
		const refused = sign();
		await desk(`
			await front();
			await waitFor(() => text().includes("wants to sign a git commit with Deploy"), 20000);
			await click(/^Cancel$/);
		`);
		expect((await refused).code).not.toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	expect(realConfig()).toBe(before);
});
