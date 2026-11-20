#!/usr/bin/env node
// Open in window, with a pop-out already open, moves that pop-out to the popup's screen. Firefox
// half of e2e/extension/popout-route.spec.ts: the background asks the open window by its id
// (windows.getCurrent) and the window answers through runtime.onMessage.
//
// Manual, not CI: it wants a stock Firefox (see driver.mjs). Build first:
//
//   pnpm --filter @vault/platform-extension build:firefox
//   FIREFOX_BINARY=/path/to/firefox node e2e/firefox/popout-route.mjs

import { EXT_ORIGIN, launch, OPENER_PAGE, serve, sleep, waitFor } from "./driver.mjs";

const POPUPS = `browser.windows.getAll().then((ws) => ws.filter((w) => w.type === "popup").length)`;

const server = await serve({ "*": { body: OPENER_PAGE } });
const firefox = await launch();
let failed = 0;
const check = (ok, what) => {
	if (!ok) failed++;
	console.log(`${ok ? "pass" : "FAIL"}  ${what}`);
};
try {
	const [tab] = (await firefox.contexts()).map((c) => c.context);
	const opener = `http://localhost:${server.port}/`;
	await firefox.createVault(tab, opener);
	const options = await firefox.openExtensionPage(tab, opener, "options.html");
	const run = (expression) => firefox.evaluate(options, expression);
	const vaultId = await run(
		`browser.storage.session.get("vault.activeId").then((r) => r["vault.activeId"])`,
	);
	const popOut = (path) =>
		run(
			`browser.runtime.sendMessage({ type: "POPOUT_OPEN", payload: { handoff: ${JSON.stringify({ path, vaultId })} } })`,
		);

	await popOut("/generator");
	const popout = await waitFor(
		async () =>
			(await firefox.contexts()).find((c) => c.url.startsWith(`${EXT_ORIGIN}/popup.html?detached`)),
		"the pop-out",
	);
	const text = () => firefox.evaluate(popout.context, "document.body.innerText");
	await waitFor(async () => /Generate password/.test(await text()), "the generator in the pop-out");

	await popOut("/settings?tab=backups");
	const moved = await waitFor(
		async () => /Cloud backups/.test(await text()),
		"Backups in the pop-out",
	).catch(() => false);
	check(moved, "the open pop-out moves to Backups");
	await sleep(1_000);
	check((await run(POPUPS)) === 1, "no second pop-out opens");
} catch (error) {
	failed++;
	console.error(error);
} finally {
	await firefox.quit();
	await server.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
