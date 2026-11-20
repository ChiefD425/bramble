import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { desk, expect, test } from "./fixtures";

// Google Drive sign-in in the desktop app. Rust runs it: the consent page would open in the system
// browser, Google sends the browser back to a loopback Rust listens on, and Rust trades the code
// and keeps the refresh token in the credential store. Google is faked in debug builds only: the
// app writes the consent URL to a file instead of opening a browser (BRAMBLE_E2E_OAUTH_URL_FILE),
// this test plays the browser coming back, and the token endpoint is a local server
// (BRAMBLE_E2E_OAUTH_TOKEN_URL). Both are read when the app starts, so this spec has its own app.
test.use({ ownApp: true });

const TOKEN_PORT = Number(process.env.BRAMBLE_E2E_OAUTH_TOKEN_PORT ?? 47811);
const URL_FILE = path.join(tmpdir(), `bramble-e2e-oauth-${process.pid}.txt`);
process.env.BRAMBLE_E2E_OAUTH_URL_FILE = URL_FILE;
process.env.BRAMBLE_E2E_OAUTH_TOKEN_URL = `http://127.0.0.1:${TOKEN_PORT}/token`;

const REFRESH = "e2e-refresh-token";

/** A token endpoint that hands out REFRESH and records each form it was sent. */
async function fakeTokenEndpoint(): Promise<{ forms: URLSearchParams[]; server: Server }> {
	const forms: URLSearchParams[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			forms.push(new URLSearchParams(body));
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ access_token: "AT", refresh_token: REFRESH, expires_in: 3599 }));
		});
	});
	await new Promise<void>((r) => server.listen(TOKEN_PORT, "127.0.0.1", r));
	return { forms, server };
}

test("connects Google Drive, keeping the refresh token out of the window", async ({ desktop }) => {
	expect(desktop.home).toBeTruthy();
	rmSync(URL_FILE, { force: true });
	const { forms, server } = await fakeTokenEndpoint();
	try {
		await desk(`
			await front();
			await click(/^Settings$/);
			await click(/^Backups$/);
			await click(/Google Drive/);
			await click(/^Connect Google Drive$/);
		`);

		// The browser coming back: the redirect Rust named, with its state and a code.
		await expect.poll(() => existsSync(URL_FILE), { timeout: 15_000 }).toBe(true);
		const consent = new URL(readFileSync(URL_FILE, "utf8"));
		expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		const back = new URL(consent.searchParams.get("redirect_uri") ?? "");
		expect(back.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		back.searchParams.set("state", consent.searchParams.get("state") ?? "");
		back.searchParams.set("code", "E2E-CODE");
		expect(await (await fetch(back)).text()).toContain("Signed in");

		// The exchange: the code, the same redirect, PKCE, and the client's secret.
		await expect.poll(() => forms.length).toBe(1);
		const form = forms[0]!;
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("code")).toBe("E2E-CODE");
		expect(form.get("redirect_uri")).toBe(consent.searchParams.get("redirect_uri"));
		expect(form.get("code_verifier")).toBeTruthy();
		expect(form.get("client_secret")).toMatch(/^GOCSPX-/);

		// One Google Drive target, its credentials in the store, and the store refusing the window.
		const seen = await desk<{
			targets: { id: string; provider: string; creds: unknown }[];
			read: string;
		}>(`
			const { desktopStorage } = await import("/src/adapters/storage.ts");
			const reg = await desktopStorage.getMeta("vault.registry");
			const vaultId = reg.vaults[0].id;
			const targets = await waitFor(async () => {
				const list = await desktopStorage.getMeta("backup.targets:" + vaultId);
				return list && list.length ? list : null;
			}, 15000);
			let read;
			try {
				read = String(await window.__TAURI_INTERNALS__.invoke("secure_get", {
					key: "backup.creds:" + vaultId + ":" + targets[0].id,
				}));
			} catch (e) {
				read = "refused: " + String(e);
			}
			return { targets, read };
		`);
		expect(seen.targets).toHaveLength(1);
		expect(seen.targets[0]).toMatchObject({ provider: "gdrive", creds: { wrap: "os" } });
		expect(JSON.stringify(seen.targets)).not.toContain(REFRESH);
		expect(seen.read).toMatch(/^refused: .*not readable or writable from here/);
	} finally {
		server.close();
		rmSync(URL_FILE, { force: true });
	}
});
