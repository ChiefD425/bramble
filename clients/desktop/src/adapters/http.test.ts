import { beforeEach, describe, expect, it, vi } from "vitest";

// The webview half of the native transport. What is under test is the marshalling, because that
// is the part that can silently corrupt a request: Tauri's channel is JSON, so bodies have to
// cross as number arrays and come back as bytes.

const h = vi.hoisted(() => ({
	calls: [] as { cmd: string; args: Record<string, unknown>; options?: unknown }[],
	reply: { status: 200, body: [] as number[] },
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args: Record<string, unknown>, options?: unknown) => {
		h.calls.push({ cmd, args, ...(options ? { options } : {}) });
		if (cmd === "http_stream_open") return 7;
		if (cmd === "stream_write") return undefined;
		return h.reply;
	},
}));

const { desktopHttp } = await import("./http");

beforeEach(() => {
	h.calls = [];
	h.reply = { status: 200, body: [] };
});

const only = () => {
	if (h.calls.length !== 1) throw new Error(`expected exactly 1 invoke, saw ${h.calls.length}`);
	return h.calls[0] as { cmd: string; args: Record<string, unknown> };
};

describe("desktopHttp", () => {
	it("sends the request to the shell with its body as a number array", async () => {
		await desktopHttp.send({
			method: "POST",
			url: "https://p.example/x",
			headers: { Authorization: "Bearer k" },
			body: new TextEncoder().encode('{"a":1}'),
		});
		const { cmd, args } = only();
		expect(cmd).toBe("http_send");
		expect(args.method).toBe("POST");
		expect(args.url).toBe("https://p.example/x");
		expect(args.headers).toEqual({ Authorization: "Bearer k" });
		expect(args.body).toEqual([...new TextEncoder().encode('{"a":1}')]);
	});

	// `undefined` would be dropped from the JSON payload entirely, and the Rust side takes an
	// Option, so the absence has to be said out loud.
	it("sends a null body rather than omitting it, and headers as an object", async () => {
		await desktopHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(only().args.body).toBeNull();
		expect(only().args.headers).toEqual({});
	});

	it("returns the reply as bytes", async () => {
		h.reply = { status: 200, body: [...new TextEncoder().encode('{"email":"a@b.c"}')] };
		const res = await desktopHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(res.body).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(res.body)).toBe('{"email":"a@b.c"}');
	});

	// The shell reports the status and nothing else; `ok` is derived here, as the backup adapter
	// already does. A refused redirect comes back as the real 3xx, not as an opaque 0, and must
	// not read as success.
	it.each([
		[200, true],
		[204, true],
		[302, false],
		[401, false],
		[500, false],
	])("derives ok=%s from status %i", async (status, ok) => {
		h.reply = { status, body: [] };
		const res = await desktopHttp.send({ method: "GET", url: "https://p.example/x" });
		expect(res.status).toBe(status);
		expect(res.ok).toBe(ok);
	});
});

describe("desktopHttp with a body too large to cross whole", () => {
	it("streams it through the shell a chunk at a time, never through http_send", async () => {
		const bytes = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 251);
		h.reply = { status: 200, body: [...new TextEncoder().encode('{"stored":true}')] };
		const res = await desktopHttp.send({
			method: "PUT",
			url: "https://mailbox.example/v1/b",
			headers: { "x-bramble-sig": "s" },
			body: {
				size: bytes.length,
				read: async (offset, length) => bytes.slice(offset, offset + length),
			},
		});
		expect(h.calls[0]).toEqual({
			cmd: "http_stream_open",
			args: {
				method: "PUT",
				url: "https://mailbox.example/v1/b",
				headers: { "x-bramble-sig": "s" },
				size: bytes.length,
			},
		});
		const writes = h.calls.filter((c) => c.cmd === "stream_write");
		expect(writes.length).toBeGreaterThan(1);
		expect(
			writes.every(
				(w) => (w.options as { headers: Record<string, string> }).headers["x-stream-id"] === "7",
			),
		).toBe(true);
		const sent = writes.flatMap((w) => [...(w.args as unknown as Uint8Array)]);
		expect(sent).toEqual([...bytes]);
		expect(h.calls.at(-1)).toEqual({ cmd: "stream_finish", args: { id: 7 } });
		expect(h.calls.some((c) => c.cmd === "http_send")).toBe(false);
		expect(res.ok).toBe(true);
		expect(new TextDecoder().decode(res.body)).toBe('{"stored":true}');
	});
});
