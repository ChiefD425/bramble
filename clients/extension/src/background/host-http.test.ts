import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

// The background's backup requests run in the crypto host as jobs, because a Chrome service
// worker cannot hold one open for a large upload. What has to hold: the body reaches the host's
// fetch intact, by the right route for its size, and nothing staged for it is left behind.

const { polledBodies } = vi.hoisted(() => ({ polledBodies: [] as string[] }));
vi.mock("./offscreen-client", async () => {
	const host = await import("../http-host");
	return {
		sendToOffscreen: async (msg: { type: string; payload: unknown }) => {
			if (msg.type === "HTTP_JOB_START") {
				return { ok: true, data: await host.startHttpJob(msg.payload as never) };
			}
			if (msg.type === "HTTP_JOB_POLL") {
				const state = host.pollHttpJob((msg.payload as { id: string }).id);
				if (state.done && "body" in state) polledBodies.push(state.body);
				return { ok: true, data: state };
			}
			return { ok: false, error: "unexpected" };
		},
	};
});

const { hostHttp } = await import("./host-http");
const idb = await import("../files/idb");

afterEach(() => vi.unstubAllGlobals());

function fetchRecorder(status = 201) {
	const calls: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response("done", { status });
		}),
	);
	return calls;
}

const bodyBytes = async (body: BodyInit | null | undefined) =>
	new Uint8Array(await new Response(body).arrayBuffer());

describe("hostHttp", () => {
	it("sends a small body inline and returns the host's response", async () => {
		const calls = fetchRecorder();
		const res = await hostHttp.send({
			method: "PUT",
			url: "https://dav.example/x",
			headers: { Authorization: "Basic abc" },
			body: new Uint8Array([1, 2, 3]),
		});
		expect(res).toMatchObject({ status: 201, ok: true, body: new TextEncoder().encode("done") });
		expect(calls[0]?.init).toMatchObject({
			method: "PUT",
			credentials: "omit",
			redirect: "manual",
		});
		expect(await bodyBytes(calls[0]?.init.body)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("returns the response headers, names lower-cased", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(null, {
						status: 200,
						headers: { Location: "https://upload.example/session?id=1", "Retry-After": "3" },
					}),
			),
		);
		const res = await hostHttp.send({ method: "POST", url: "https://api.example/start" });
		expect(res.headers?.location).toBe("https://upload.example/session?id=1");
		expect(res.headers?.["retry-after"]).toBe("3");
	});

	it("stages a large body for the host and drops it afterwards", async () => {
		const calls = fetchRecorder();
		const put = vi.spyOn(idb, "putHandoff");
		const size = 600 * 1024;
		await hostHttp.send({
			method: "PUT",
			url: "https://dav.example/big",
			body: { size, read: async (o, l) => Uint8Array.from({ length: l }, (_, i) => (o + i) % 251) },
		});
		const sent = await bodyBytes(calls[0]?.init.body);
		expect(sent.length).toBe(size);
		expect(sent[size - 1]).toBe((size - 1) % 251);
		const token = await put.mock.results[0]?.value;
		expect(await idb.readHandoff(token)).toBeNull();
	});

	it("fails rather than hangs when the host lost the job", async () => {
		const host = await import("../http-host");
		vi.spyOn(host, "pollHttpJob").mockReturnValueOnce({
			done: true,
			error: "the request was lost when the crypto host restarted",
		});
		fetchRecorder();
		await expect(hostHttp.send({ method: "GET", url: "https://dav.example/" })).rejects.toThrow(
			/lost/,
		);
	});
});

describe("the mailbox's blob mover", () => {
	it("lands a download in the vault's blob store, never crossing back as a message", async () => {
		const bytes = new Uint8Array(3 * 1024 * 1024).fill(7);
		const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(bytes, { status: 200 })),
		);
		const { hostBlobMover } = await import("./host-http");
		const store = idb.idbBlobStore("mailbox-v1");
		const request = { method: "GET" as const, url: "https://m.example/b", headers: {} };
		expect(await hostBlobMover("mailbox-v1", store).download(hash, request)).toBe("stored");
		expect(await store.has(hash)).toBe(true);
		expect(polledBodies.at(-1)).toBe("");
	});

	it("answers missing for a 404", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 })),
		);
		const { hostBlobMover } = await import("./host-http");
		const store = idb.idbBlobStore("mailbox-v2");
		const request = { method: "GET" as const, url: "https://m.example/b", headers: {} };
		expect(await hostBlobMover("mailbox-v2", store).download("a".repeat(64), request)).toBe(
			"missing",
		);
	});
});
