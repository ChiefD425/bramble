// Billing, the mailbox and Stripe, faked inside the browser for the account page's specs. Every
// request the page makes is recorded, so a spec can check what left it and where the number went.

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext, Request, Route } from "@playwright/test";

const fromWebsite = createRequire(path.resolve("website/package.json"));
const load = (id: string) => import(pathToFileURL(fromWebsite.resolve(id)).href);

/** A real challenge the page's solver answers at once: the counter is 2. */
async function cheapChallenge(): Promise<unknown> {
	const { createChallenge } = await load("altcha-lib");
	const { deriveKey } = await load("altcha-lib/algorithms/pbkdf2");
	return createChallenge({
		algorithm: "PBKDF2/SHA-256",
		cost: 1,
		counter: 2,
		deriveKey,
		hmacSignatureSecret: "test-only",
	});
}

export interface Reply {
	code: number;
	body: unknown;
}

export interface Services {
	/** Every request the page sent anywhere, the page's own server included. */
	all: string[];
	/** Requests to billing, the mailbox and Stripe, with their headers and bodies. */
	calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[];
	account: () => Reply | Promise<Reply>;
	status: () => Reply | Promise<Reply>;
	checkout: () => Reply | Promise<Reply>;
	purchases: () => Reply | Promise<Reply>;
	refund: () => Reply | Promise<Reply>;
	remove: () => Reply | Promise<Reply>;
}

const STRIPE = "https://checkout.stripe.com/c/pay/test";

export async function mockServices(context: BrowserContext, number: string): Promise<Services> {
	const services: Services = {
		all: [],
		calls: [],
		account: () => ({ code: 200, body: { number } }),
		status: () => ({ code: 403, body: { error: "account_unknown" } }),
		checkout: () => ({ code: 200, body: { url: STRIPE } }),
		purchases: () => ({ code: 200, body: { purchases: [] } }),
		refund: () => ({ code: 404, body: { error: "nothing_to_refund" } }),
		remove: () => ({ code: 200, body: { deleted: true } }),
	};
	context.on("request", (req) => services.all.push(req.url()));

	const reply = async (route: Route, req: Request, out: Reply) => {
		const cors = {
			"access-control-allow-origin": req.headers().origin ?? "*",
			"access-control-allow-headers": "content-type, x-bramble-account",
			"access-control-allow-methods": "GET, POST, OPTIONS",
		};
		if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
		services.calls.push({
			method: req.method(),
			url: req.url(),
			headers: req.headers(),
			body: req.postData(),
		});
		await route.fulfill({
			status: out.code,
			headers: { ...cors, "content-type": "application/json" },
			body: JSON.stringify(out.body),
		});
	};

	await context.route("https://billing.bramble.sh/**", async (route, req) => {
		const { pathname } = new URL(req.url());
		const out: Reply =
			pathname === "/v1/challenge"
				? { code: 200, body: await cheapChallenge() }
				: pathname === "/v1/accounts"
					? await services.account()
					: pathname === "/v1/accounts/delete"
						? await services.remove()
						: pathname === "/v1/checkout"
							? await services.checkout()
							: pathname === "/v1/purchases"
								? await services.purchases()
								: pathname === "/v1/refunds"
									? await services.refund()
									: { code: 404, body: { error: "not_found" } };
		await reply(route, req, out);
	});
	await context.route("https://mailbox.bramble.sh/**", async (route, req) =>
		reply(route, req, await services.status()),
	);
	await context.route("https://checkout.stripe.com/**", (route) =>
		route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Stripe test checkout</h1>" }),
	);
	return services;
}
