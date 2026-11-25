import { defineConfig } from "@playwright/test";

// The website's account page against faked billing, mailbox and Stripe: every call they make is
// routed inside the browser (e2e/website/mocks.ts), so nothing leaves the machine.
//
// Run: pnpm test:e2e:website
export default defineConfig({
	testDir: "./e2e/website",
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: [["list"]],
	forbidOnly: !!process.env.CI,
	retries: 0,
	use: { baseURL: "http://localhost:4399" },
	webServer: {
		// --ignore-lock keeps it in the foreground: Astro moves a dev server it thinks an AI agent
		// started to the background, and Playwright would see the foreground one exit.
		command: "pnpm --filter @vault/website exec astro dev --port 4399 --strictPort --ignore-lock",
		// The home page, so the server counts as up before the account page exists.
		url: "http://localhost:4399/",
		// Its own port and never reused, so a spec cannot reach some other server listening there.
		reuseExistingServer: false,
		stdout: "ignore",
		timeout: 120_000,
	},
});
