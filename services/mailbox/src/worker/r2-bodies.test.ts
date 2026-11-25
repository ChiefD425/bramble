import { env } from "cloudflare:workers";
import { sha256Hex } from "@vault/core/src/sync/mailbox/protocol.ts";
import { describe, expect, it, vi } from "vitest";
import { HashMismatchError } from "../core/bodies.ts";
import { r2Bodies } from "./r2-bodies.ts";

// The hosted body store: every message and blob body, in R2, refused unless it hashes to its
// address and is exactly as long as declared.

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
/** A stream of unknown length, as the core hands one over after counting it. */
const unknownLength = (b: Uint8Array) =>
	new Response(b).body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
const key = (name: string) => `b/${crypto.randomUUID()}/${name}`;

describe("r2Bodies", () => {
	it("stores a counted stream when told its size, and streams it back", async () => {
		const store = r2Bodies(env.BODIES);
		const body = bytes(70_000);
		const k = key("a");
		await store.put(k, unknownLength(body), { sha256: await sha256Hex(body), size: body.length });
		const got = await store.get(k);
		expect(got?.size).toBe(body.length);
		expect(new Uint8Array(await new Response(got?.body).arrayBuffer())).toEqual(body);
	});

	it("refuses a body whose bytes don't match and keeps nothing", async () => {
		const store = r2Bodies(env.BODIES);
		const k = key("b");
		await expect(
			store.put(k, unknownLength(bytes(10)), { sha256: await sha256Hex(bytes(10, 1)), size: 10 }),
		).rejects.toBeInstanceOf(HashMismatchError);
		expect(await env.BODIES.head(k)).toBeNull();
	});

	it("refuses a body shorter than its size and keeps nothing", async () => {
		const store = r2Bodies(env.BODIES);
		const k = key("c");
		await expect(store.put(k, unknownLength(bytes(10)), { size: 20 })).rejects.toThrow();
		expect(await env.BODIES.head(k)).toBeNull();
	});

	it("a cut-off upload leaves alone a body already stored under that key", async () => {
		const store = r2Bodies(env.BODIES);
		const good = bytes(20, 5);
		const k = key("d");
		await store.put(k, unknownLength(good), { sha256: await sha256Hex(good), size: 20 });
		// The client goes away partway: its stream errors.
		const cutOff = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes(10));
				controller.error(new Error("the client went away"));
			},
		});
		await expect(store.put(k, cutOff, { size: 20 })).rejects.toThrow("the client went away");
		const kept = await store.get(k);
		expect(new Uint8Array(await new Response(kept?.body).arrayBuffer())).toEqual(good);
	});

	it("deleting a missing key is fine, and a missing key reads as null", async () => {
		const store = r2Bodies(env.BODIES);
		await store.delete(key("gone"));
		expect(await store.get(key("never"))).toBeNull();
	});

	it("lists every key across pages, with its upload time", async () => {
		const prefix = `m/${crypto.randomUUID()}`;
		for (const n of [1, 2, 3, 4, 5]) await env.BODIES.put(`${prefix}/${n}`, bytes(1));
		const seen: { key: string; modifiedAt: number }[] = [];
		for await (const entry of r2Bodies(env.BODIES, { pageSize: 2 }).keys()) {
			if (entry.key.startsWith(prefix)) seen.push(entry);
		}
		expect(seen.map((e) => e.key).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `${prefix}/${n}`));
		expect(seen.every((e) => Math.abs(e.modifiedAt - Date.now()) < 60_000)).toBe(true);
	});

	it("deleteMany removes up to 1,000 keys in one call", async () => {
		const keys = Array.from({ length: 1001 }, (_, i) => `m/many/${String(i).padStart(4, "0")}`);
		await Promise.all(keys.map((k) => env.BODIES.put(k, "x")));
		const deletes = vi.spyOn(env.BODIES, "delete");
		await r2Bodies(env.BODIES).deleteMany(keys);
		expect(deletes).toHaveBeenCalledTimes(2);
		expect((await env.BODIES.list({ prefix: "m/many/" })).objects).toHaveLength(0);
		deletes.mockRestore();
	});

	it("lists keys after a given one, in key order", async () => {
		for (const k of ["m/after/c", "m/after/a", "m/after/b"]) await env.BODIES.put(k, "x");
		const listed: string[] = [];
		for await (const { key } of r2Bodies(env.BODIES).keys("m/after/a")) {
			if (key.startsWith("m/after/")) listed.push(key);
		}
		expect(listed).toEqual(["m/after/b", "m/after/c"]);
	});
});
