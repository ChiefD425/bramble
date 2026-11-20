import type { Worker } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, expectUnlocked, openPopup } from "./helpers";

// Google Drive sign-in on Chromium. Google's Desktop app client only redirects to a loopback, and
// Chromium's launchWebAuthFlow can't return to one, so the consent page opens in a tab and the
// background reads the code off the tab's URL when Google sends it to 127.0.0.1, where nothing
// listens. What this proves in a real Chromium: that the background sees that URL at all (the
// page fails to load), checks the state, trades the code with the same redirect and keeps only
// the refresh token, VEK-wrapped, as a gdrive target. Google itself is never reached: the worker's
// tabs.create opens a blank tab and records the consent URL (Playwright's routing doesn't catch a
// tab an extension opens), the test plays Google by sending that tab to the redirect, and the
// token endpoint is a fetch stub in the worker that makes the exchange.

const TOKEN = "https://oauth2.googleapis.com/token";

/** Swap the worker's tabs.create for one that opens a blank tab and records the URL it was given. */
async function interceptConsentTab(sw: Worker) {
	await sw.evaluate(() => {
		const g = globalThis as unknown as { __consentUrls: string[] };
		g.__consentUrls = [];
		const real = chrome.tabs.create.bind(chrome.tabs);
		chrome.tabs.create = ((props: chrome.tabs.CreateProperties) => {
			g.__consentUrls.push(props.url ?? "");
			return real({ ...props, url: "about:blank" });
		}) as typeof chrome.tabs.create;
	});
}

const consentUrl = async (sw: Worker) =>
	new URL(
		await sw.evaluate(
			() => (globalThis as unknown as { __consentUrls: string[] }).__consentUrls[0]!,
		),
	);

test("connects Google Drive by catching the loopback redirect in a tab", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);
	await openPopup(page, extensionId);
	await expectUnlocked(page);

	const sw = await backgroundWorker(context);
	await interceptConsentTab(sw);
	await sw.evaluate((token) => {
		const real = globalThis.fetch;
		const seen: string[] = [];
		(globalThis as unknown as { __tokenRequests: string[] }).__tokenRequests = seen;
		globalThis.fetch = async (input, init) => {
			if (String(input) === token) {
				seen.push(String(init?.body));
				return Response.json({
					access_token: "AT",
					refresh_token: "e2e-refresh-token",
					expires_in: 3599,
				});
			}
			return real(input, init);
		};
	}, TOKEN);

	const opened = context.waitForEvent("page", (pg) => pg.url() === "about:blank");
	const result = page.evaluate(() =>
		chrome.runtime.sendMessage({ type: "BACKUP_OAUTH_CONNECT", payload: { providerId: "gdrive" } }),
	);
	const tab = await opened;

	// Google's side: after consent it sends the tab to the redirect with the state and a code.
	// Nothing listens on that port, so the navigation itself fails; the background reads the URL.
	const authorize = await consentUrl(sw);
	const back = new URL(authorize.searchParams.get("redirect_uri")!);
	back.searchParams.set("state", authorize.searchParams.get("state")!);
	back.searchParams.set("code", "AUTH-CODE");
	await tab.goto(back.toString()).catch(() => {});
	expect(await result).toMatchObject({ ok: true });

	// The consent request: Desktop client, a loopback redirect, offline access, PKCE.
	expect(authorize.origin + authorize.pathname).toBe(
		"https://accounts.google.com/o/oauth2/v2/auth",
	);
	const p = authorize.searchParams;
	expect(p.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
	expect(p.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
	expect(p.get("access_type")).toBe("offline");
	expect(p.get("code_challenge_method")).toBe("S256");

	// The exchange: the code, the same redirect, the PKCE verifier.
	const [exchange] = await sw.evaluate(
		() => (globalThis as unknown as { __tokenRequests: string[] }).__tokenRequests,
	);
	const form = new URLSearchParams(exchange);
	expect(form.get("grant_type")).toBe("authorization_code");
	expect(form.get("code")).toBe("AUTH-CODE");
	expect(form.get("redirect_uri")).toBe(p.get("redirect_uri"));
	expect(form.get("code_verifier")).toBeTruthy();

	// The consent tab is gone, and the vault has a gdrive target holding no plaintext token.
	await expect.poll(() => tab.isClosed()).toBe(true);
	const stored = await sw.evaluate(async () => {
		const all = await chrome.storage.local.get(null);
		return Object.entries(all).filter(([k]) => k.startsWith("backup.targets:"));
	});
	expect(stored).toHaveLength(1);
	const [target] = stored[0]![1] as { provider: string; providerId: string; creds: unknown }[];
	expect(target).toMatchObject({ provider: "gdrive", providerId: "gdrive" });
	expect(JSON.stringify(target)).not.toContain("e2e-refresh-token");
});

test("a closed consent tab cancels the connect and saves nothing", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);
	await openPopup(page, extensionId);
	await expectUnlocked(page);

	const sw = await backgroundWorker(context);
	await interceptConsentTab(sw);
	const consent = context.waitForEvent("page", (pg) => pg.url() === "about:blank");
	const result = page.evaluate(() =>
		chrome.runtime.sendMessage({ type: "BACKUP_OAUTH_CONNECT", payload: { providerId: "gdrive" } }),
	);
	await (await consent).close();
	expect(await result).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/i) });

	const stored = await sw.evaluate(async () => {
		const all = await chrome.storage.local.get(null);
		return Object.entries(all).filter(([k]) => k.startsWith("backup.targets:"));
	});
	expect(stored.flatMap(([, v]) => v as unknown[])).toHaveLength(0);
});
