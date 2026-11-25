import { EMPTY_SHA256 } from "@vault/core/src/sync/mailbox/protocol.ts";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "../node/db.ts";
import { createMailbox, makeServer, memoryBodies, setup } from "../test/harness.ts";
import { HashMismatchError } from "./bodies.ts";

describe("server skeleton", () => {
	it("answers the health probe", async () => {
		const { app } = makeServer();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("creates every table from the migrations", () => {
		const { db } = openDb(":memory:");
		const names = db
			.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
			.map((r: { name: string }) => r.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"mailboxes",
				"members",
				"messages",
				"deliveries",
				"blobs",
				"blob_deliveries",
				"blob_wants",
				"expiry_markers",
			]),
		);
	});

	it("memoryBodies refuses bytes that do not match the declared hash", async () => {
		const bodies = memoryBodies();
		await expect(
			bodies.put("b/x/y", new Uint8Array([1]), { sha256: EMPTY_SHA256 }),
		).rejects.toBeInstanceOf(HashMismatchError);
		expect(await bodies.get("b/x/y")).toBeNull();
	});
});

describe("browser clients", () => {
	const ORIGIN = "http://localhost:5199";

	it("answers a browser's preflight", async () => {
		const { app } = makeServer();
		const res = await app.request("/v1/mailboxes/x/inbox", {
			method: "OPTIONS",
			headers: {
				origin: ORIGIN,
				"access-control-request-method": "GET",
				"access-control-request-headers": "x-bramble-key,x-bramble-sig",
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		const allowed = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
		expect(allowed).toContain("x-bramble-key");
		expect(allowed).toContain("x-bramble-sig");
		expect(res.headers.get("access-control-allow-credentials")).toBeNull();
	});

	it("lets a browser read a signed answer", async () => {
		const {
			devices: [owner],
		} = await setup(1);
		if (!owner) throw new Error("no device");
		const id = await createMailbox(owner);
		const res = await owner.request("GET", `/v1/mailboxes/${id}/members`, undefined, {
			headers: { origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("lets a browser read a refusal, so a client can correct its clock", async () => {
		const { app } = makeServer();
		const res = await app.request("/v1/mailboxes/x/inbox", { headers: { origin: ORIGIN } });
		expect(res.status).toBe(401);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});
