import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGdriveTarget } from "./gdrive";
import { PART_SIZE } from "./types";
import { bytesSource } from "./zip";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const TOKEN = "https://oauth2.googleapis.com/token";
const FOLDER = "application/vnd.google-apps.folder";

afterEach(() => vi.unstubAllGlobals());

interface Item {
	id: string;
	name: string;
	parent: string;
	mimeType: string;
	data?: Uint8Array;
	createdTime: string;
}

/**
 * Just enough of Drive v3 for the target: folder and file queries by name, parent and type,
 * folder creation, resumable upload sessions (create and update), paged listing, download and
 * delete. Tests assert what ends up stored, not the exact order of calls.
 */
class FakeDrive {
	items = new Map<string, Item>();
	calls: { method: string; url: string; init: RequestInit }[] = [];
	pageSize = 1000;
	/** Return this response instead, for the next call whose method + url match. */
	override?: (method: string, url: string) => Response | undefined;
	private seq = 0;
	private sessions = new Map<string, { fileId?: string; name?: string; parent?: string }>();

	add(name: string, parent: string, mimeType = "application/octet-stream", data?: Uint8Array) {
		const id = `id${++this.seq}`;
		const createdTime = new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString();
		this.items.set(id, { id, name, parent, mimeType, data, createdTime });
		return id;
	}

	/** The item at a slash path of names under My Drive, e.g. "Bramble/bramble/x.bramble". */
	at(path: string): Item | undefined {
		let parent = "root";
		let found: Item | undefined;
		for (const name of path.split("/")) {
			found = [...this.items.values()].find((i) => i.parent === parent && i.name === name);
			if (!found) return undefined;
			parent = found.id;
		}
		return found;
	}

	readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
		const url = String(input);
		const method = init.method ?? "GET";
		this.calls.push({ method, url, init });
		const forced = this.override?.(method, url);
		if (forced) return forced;
		const u = new URL(url);
		const body = async () => new Uint8Array(await new Response(init.body).arrayBuffer());
		const json = async () => JSON.parse(new TextDecoder().decode(await body()));

		if (url === TOKEN) return Response.json({ access_token: "MINTED" });
		if (u.hostname === "upload.fake") {
			const s = this.sessions.get(u.pathname);
			if (!s) return new Response("no session", { status: 404 });
			const data = await body();
			const id = s.fileId ?? this.add(s.name!, s.parent!);
			this.items.get(id)!.data = data;
			return Response.json({ id });
		}
		if (url.startsWith(UPLOAD)) {
			const sid = `/s${++this.seq}`;
			const fileId = u.pathname.split("/files/")[1];
			if (method === "PATCH") this.sessions.set(sid, { fileId });
			else {
				const meta = await json();
				this.sessions.set(sid, { name: meta.name, parent: meta.parents[0] });
			}
			return new Response(null, {
				status: 200,
				headers: { Location: `https://upload.fake${sid}` },
			});
		}
		if (u.pathname === "/drive/v3/files" && method === "POST") {
			const meta = await json();
			return Response.json({ id: this.add(meta.name, meta.parents[0], meta.mimeType) });
		}
		if (u.pathname === "/drive/v3/files" && method === "GET") return this.list(u);
		const id = u.pathname.split("/files/")[1]!;
		const item = this.items.get(id);
		if (!item)
			return Response.json({ error: { code: 404, message: "File not found" } }, { status: 404 });
		if (method === "DELETE") {
			this.items.delete(id);
			return new Response(null, { status: 204 });
		}
		if (u.searchParams.get("alt") === "media") return new Response(item.data as BodyInit);
		return new Response("unhandled", { status: 500 });
	};

	private list(u: URL): Response {
		const q = u.searchParams.get("q") ?? "";
		const unq = (s: string) => s.replace(/\\(.)/g, "$1");
		const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1];
		const parent = q.match(/'((?:[^'\\]|\\.)*)' in parents/)?.[1];
		const isType = q.match(/mimeType = '([^']*)'/)?.[1];
		const notType = q.match(/mimeType != '([^']*)'/)?.[1];
		const all = [...this.items.values()]
			.filter((i) => (name === undefined || i.name === unq(name)) && i.parent === unq(parent ?? ""))
			.filter((i) => (isType ? i.mimeType === isType : true))
			.filter((i) => (notType ? i.mimeType !== notType : true))
			.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
		const start = Number(u.searchParams.get("pageToken") ?? 0);
		const size = Math.min(Number(u.searchParams.get("pageSize") ?? 100), this.pageSize);
		const page = all.slice(start, start + size);
		return Response.json({
			files: page.map((i) => ({
				id: i.id,
				name: i.name,
				size: String(i.data?.length ?? 0),
				modifiedTime: i.createdTime,
			})),
			nextPageToken: start + size < all.length ? String(start + size) : undefined,
		});
	}
}

function fakeDrive(): FakeDrive {
	const drive = new FakeDrive();
	vi.stubGlobal("fetch", vi.fn(drive.fetch));
	return drive;
}

const target = (extra: { path?: string; accessToken?: string } = {}) =>
	createGdriveTarget({ kind: "gdrive", refreshToken: "RT", accessToken: "AT", ...extra });

const bytes = (...b: number[]) => bytesSource(new Uint8Array(b));

describe("createGdriveTarget", () => {
	it("writes a backup into a Bramble folder in My Drive, creating the folders it needs", async () => {
		const drive = fakeDrive();
		await target().put("bramble/bramble-x.bramble", bytes(1, 2, 3));

		expect(drive.at("Bramble")?.mimeType).toBe(FOLDER);
		expect(drive.at("Bramble/bramble")?.mimeType).toBe(FOLDER);
		expect(drive.at("Bramble/bramble/bramble-x.bramble")?.data).toEqual(new Uint8Array([1, 2, 3]));
		for (const c of drive.calls) {
			expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer AT");
		}
	});

	it("nests under a configured subfolder", async () => {
		const drive = fakeDrive();
		await target({ path: "/Work/" }).put("bramble/x.bramble", bytes(1));
		expect(drive.at("Bramble/Work/bramble/x.bramble")).toBeDefined();
	});

	it("reuses folders that already exist, the oldest of any duplicates, and looks each up once", async () => {
		const drive = fakeDrive();
		const root = drive.add("Bramble", "root", FOLDER);
		drive.add("Bramble", "root", FOLDER);
		const t = target();
		await t.put("bramble/a.bramble", bytes(1));
		await t.put("bramble/b.bramble", bytes(2));

		const roots = [...drive.items.values()].filter((i) => i.name === "Bramble");
		expect(roots).toHaveLength(2);
		const sub = drive.at("Bramble/bramble")!;
		expect(sub.parent).toBe(root);
		const folderLookups = drive.calls.filter(
			(c) =>
				c.method === "GET" &&
				new URL(c.url).searchParams.get("q")?.includes(`mimeType = '${FOLDER}'`),
		);
		expect(folderLookups).toHaveLength(2);
	});

	it("replaces a file of the same name rather than adding a second one", async () => {
		const drive = fakeDrive();
		const t = target();
		await t.put("bramble/x.bramble", bytes(1));
		await t.put("bramble/x.bramble", bytes(2, 2));

		const copies = [...drive.items.values()].filter((i) => i.name === "x.bramble");
		expect(copies).toHaveLength(1);
		expect(copies[0]!.data).toEqual(new Uint8Array([2, 2]));
	});

	it("sends a large backup whole in one request, never in parts Drive answers with a 308", async () => {
		const drive = fakeDrive();
		const size = PART_SIZE + 5;
		const read = vi.fn(async (o: number, l: number) =>
			Uint8Array.from({ length: l }, (_, i) => (o + i) % 251),
		);
		await target().put("bramble/big.bramble", { size, read });

		const puts = drive.calls.filter((c) => c.method === "PUT");
		expect(puts).toHaveLength(1);
		expect(puts[0]!.init.body).toBeInstanceOf(Blob);
		expect(drive.at("Bramble/bramble/big.bramble")?.data?.length).toBe(size);
	});

	it("fails the upload when Drive opens no session", async () => {
		const drive = fakeDrive();
		drive.override = (m, url) =>
			m === "POST" && url.startsWith(UPLOAD) ? new Response(null, { status: 200 }) : undefined;
		await expect(target().put("bramble/x.bramble", bytes(1))).rejects.toThrow(/session/);
	});

	it("lists the files in a folder as keys, across pages, leaving folders out", async () => {
		const drive = fakeDrive();
		drive.pageSize = 2;
		const t = target();
		for (const n of ["a", "b", "c"]) await t.put(`bramble/${n}.bramble`, bytes(1, 2));
		drive.add("nested", drive.at("Bramble/bramble")!.id, FOLDER);

		const listed = await t.list("bramble/");
		expect(listed.map((o) => o.key).sort()).toEqual([
			"bramble/a.bramble",
			"bramble/b.bramble",
			"bramble/c.bramble",
		]);
		expect(listed[0]!.size).toBe(2);
		expect(listed[0]!.lastModified).toMatch(/^2026-/);
	});

	it("lists nothing, and creates nothing, when the folder doesn't exist yet", async () => {
		const drive = fakeDrive();
		expect(await target().list("bramble/")).toEqual([]);
		expect(drive.items.size).toBe(0);
	});

	it("downloads a backup by its key", async () => {
		fakeDrive();
		const t = target();
		await t.put("bramble/x.bramble", bytes(4, 5, 6));
		expect(await t.get("bramble/x.bramble")).toEqual(new Uint8Array([4, 5, 6]));
	});

	it("fails a download of a key that isn't there", async () => {
		fakeDrive();
		await expect(target().get("bramble/missing.bramble")).rejects.toThrow(/not found/i);
	});

	it("deletes by key, and treats an already-missing file as deleted", async () => {
		const drive = fakeDrive();
		const t = target();
		await t.put("bramble/x.bramble", bytes(1));
		await t.remove("bramble/x.bramble");
		expect(drive.at("Bramble/bramble/x.bramble")).toBeUndefined();
		await expect(t.remove("bramble/x.bramble")).resolves.toBeUndefined();
		await expect(t.remove("elsewhere/y.bramble")).resolves.toBeUndefined();
	});

	it("throws when a delete fails for any other reason", async () => {
		const drive = fakeDrive();
		const t = target();
		await t.put("bramble/x.bramble", bytes(1));
		drive.override = (m) =>
			m === "DELETE"
				? Response.json({ error: { code: 500, message: "Backend Error" } }, { status: 500 })
				: undefined;
		await expect(t.remove("bramble/x.bramble")).rejects.toThrow(
			"Google Drive delete failed (500: Backend Error)",
		);
	});

	it("matches names with quotes exactly", async () => {
		const drive = fakeDrive();
		// A second target has no cached folder ids, so it must find "it's" by name.
		await target({ path: "it's" }).put("bramble/x.bramble", bytes(1));
		await target({ path: "it's" }).put("bramble/y.bramble", bytes(1));
		expect(drive.at("Bramble/it's/bramble/y.bramble")).toBeDefined();
		expect([...drive.items.values()].filter((i) => i.name === "it's")).toHaveLength(1);
	});

	it("mints an access token from the refresh token, and re-mints once on a 401", async () => {
		const drive = fakeDrive();
		let rejected = false;
		drive.override = (m, url) => {
			if (m === "GET" && url.startsWith(API) && !rejected) {
				rejected = true;
				return new Response(null, { status: 401 });
			}
			return undefined;
		};
		await target({ accessToken: undefined }).list("bramble/");
		const tokens = drive.calls.filter((c) => c.url === TOKEN);
		expect(tokens).toHaveLength(2);
		const last = drive.calls.at(-1)!;
		expect((last.init.headers as Record<string, string>).Authorization).toBe("Bearer MINTED");
	});

	it("says what Drive said when a call fails", async () => {
		const drive = fakeDrive();
		drive.override = (m, url) =>
			m === "POST" && url.startsWith(UPLOAD)
				? Response.json(
						{ error: { code: 403, message: "The user's Drive storage quota has been exceeded." } },
						{ status: 403 },
					)
				: undefined;
		await expect(target().put("bramble/x.bramble", bytes(1))).rejects.toThrow(
			"Google Drive upload failed (403: The user's Drive storage quota has been exceeded.)",
		);
	});

	describe("rate limits", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		const limited = (status: number, reason: string, retryAfter?: string) =>
			Response.json(
				{ error: { code: status, message: "Rate Limit Exceeded", errors: [{ reason }] } },
				{ status, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
			);

		it("waits as long as Retry-After says on a 429, then tries again", async () => {
			const drive = fakeDrive();
			let n = 0;
			drive.override = () => (n++ === 0 ? limited(429, "rateLimitExceeded", "2") : undefined);
			const done = target().list("bramble/");
			await vi.advanceTimersByTimeAsync(1999);
			expect(drive.calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(done).resolves.toEqual([]);
		});

		it("treats Drive's 403 rate-limit reasons the same way, and gives up after three retries", async () => {
			const drive = fakeDrive();
			drive.override = () => limited(403, "userRateLimitExceeded");
			const done = expect(target().list("bramble/")).rejects.toThrow(
				"Google Drive list failed (403: Rate Limit Exceeded)",
			);
			await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
			await done;
			expect(drive.calls).toHaveLength(4);
		});

		it("does not retry a 403 that isn't a rate limit", async () => {
			const drive = fakeDrive();
			drive.override = () => limited(403, "insufficientFilePermissions");
			await expect(target().list("bramble/")).rejects.toThrow(/403/);
			expect(drive.calls).toHaveLength(1);
		});
	});
});
