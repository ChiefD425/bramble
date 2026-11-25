import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

/** One folder for the mailbox's data, wiped as the server starts: a fresh one per run, without a
 * new folder every time Playwright loads this config. */
const MAILBOX_DATA = path.join(tmpdir(), "bramble-e2e-mailbox");

// Two-peer sync tests: the browser extension and the mobile SPA pairing over WebRTC through a
// local signaling relay. Separate from playwright.config.ts because they need two servers up and
// are slower than the single-context extension tests.
//
// Run: pnpm test:e2e:sync   (build the extension first, as with the other e2e suite)
export default defineConfig({
	testDir: "./e2e/sync",
	// Both peers share the relay and fixed ports; nothing here is parallel-safe.
	fullyParallel: false,
	workers: 1,
	// A real handshake plus two Argon2 vault builds.
	timeout: 180_000,
	expect: { timeout: 30_000 },
	reporter: [["list"]],
	forbidOnly: !!process.env.CI,
	retries: 0,
	webServer: [
		{
			// A WebSocket server, so wait on the port rather than an HTTP response.
			command: "node services/nostr-relay/node/relay.mjs",
			port: 7400,
			// The attachments spec reads /stats to show file bytes never passed through it.
			env: { RELAY_STATS: "1" },
			reuseExistingServer: !process.env.CI,
			stdout: "ignore",
		},
		{
			// The mailbox, on a fresh data directory every run. Its own port and never reused, so a
			// spec cannot reach some other server that happens to be listening there.
			command: `node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })" "${MAILBOX_DATA}" && node services/mailbox/src/node/bin.ts`,
			url: "http://localhost:7401/health",
			env: {
				PORT: "7401",
				DATA_DIR: MAILBOX_DATA,
			},
			reuseExistingServer: false,
			stdout: "ignore",
		},
		{
			command: "pnpm --filter @vault/platform-mobile exec vite --port 5199 --strictPort",
			url: "http://localhost:5199",
			reuseExistingServer: !process.env.CI,
			stdout: "ignore",
		},
	],
});
