import {
	fetchTransport,
	type HttpBodySource,
	type HttpResponse,
	type HttpTransport,
} from "../adapters/http";
import { refreshAccessToken } from "./oauth";
import { MAX_RETRY_WAIT_MS, RATE_LIMIT_RETRIES, retryDelayMs, sleep } from "./rate-limit";
import {
	type BackupObject,
	type BackupTarget,
	type GdriveConfig,
	PART_SIZE,
	readAll,
	responseText,
	withBearer,
} from "./types";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
/** The folder in My Drive that everything goes under. */
const ROOT_FOLDER = "Bramble";

interface Call {
	method: string;
	headers?: Record<string, string>;
	body?: Uint8Array | HttpBodySource;
}

interface DriveFile {
	id: string;
	name?: string;
	size?: string;
	modifiedTime?: string;
}

const json = <T>(res: HttpResponse): T => JSON.parse(responseText(res) || "{}") as T;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Drive's error body: `{ error: { message, errors: [{ reason }] } }`. */
function driveError(res: HttpResponse): { message?: string; reasons: string[] } {
	try {
		const { error } = json<{ error?: { message?: unknown; errors?: { reason?: unknown }[] } }>(res);
		return {
			message: typeof error?.message === "string" ? error.message : undefined,
			reasons: (error?.errors ?? []).map((e) => String(e.reason)),
		};
	} catch {
		return { reasons: [] };
	}
}

function failure(what: string, res: HttpResponse): Error {
	const detail = driveError(res).message ?? responseText(res).trim().slice(0, 200);
	return new Error(
		`Google Drive ${what} failed (${detail ? `${res.status}: ${detail}` : res.status})`,
	);
}

// Drive reports most rate limits as a 403 with one of these reasons, some as a 429.
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const isRateLimited = (res: HttpResponse) =>
	res.status === 429 ||
	(res.status === 403 && driveError(res).reasons.some((r) => RATE_LIMIT_REASONS.has(r)));

/** A string literal for a Drive query: backslashes and single quotes escaped. */
const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const segments = (path: string) => path.split("/").filter(Boolean);

/**
 * A Google Drive BackupTarget over the Drive v3 REST API, under the `drive.file` scope: Bramble
 * sees only what it created. Keys map to folders under a "Bramble" folder in My Drive (plus the
 * optional subfolder), so `bramble/x.bramble` is `My Drive/Bramble/bramble/x.bramble`. Folder ids
 * are looked up by name under their parent, the oldest first should two devices have raced to
 * create one, and kept for the life of the target. See docs/cloud-storage-backups.md.
 *
 * Auth is a bearer access token minted lazily from the stored refresh token and re-minted once on
 * a 401, as for Dropbox. `send` only carries the requests.
 */
export function createGdriveTarget(
	cfg: GdriveConfig,
	send: HttpTransport = fetchTransport,
): BackupTarget {
	const base = [ROOT_FOLDER, ...segments(cfg.path ?? "")];
	const folders = new Map<string, string>();
	let accessToken = cfg.accessToken ?? "";

	// Null when the transport authenticates: it adds the bearer, and mints a fresh one after a 401.
	async function token(): Promise<string | null> {
		if (!cfg.refreshToken) return null;
		if (!accessToken) accessToken = await refreshAccessToken("gdrive", cfg.refreshToken);
		return accessToken;
	}

	async function call(url: string, init: Call, retry = true, attempt = 0): Promise<HttpResponse> {
		const res = await send.send({
			method: init.method,
			url,
			body: init.body,
			headers: withBearer(init.headers, await token()),
		});
		if (res.status === 401 && retry) {
			accessToken = "";
			return call(url, init, false, attempt);
		}
		if (isRateLimited(res) && attempt < RATE_LIMIT_RETRIES) {
			const wait = retryDelayMs(res, attempt);
			if (wait <= MAX_RETRY_WAIT_MS) {
				await sleep(wait);
				return call(url, init, retry, attempt + 1);
			}
		}
		return res;
	}

	/** Every page of a files.list query, oldest first. */
	async function query(what: string, q: string): Promise<DriveFile[]> {
		const found: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const url = new URL(API);
			url.searchParams.set("q", `${q} and trashed = false`);
			url.searchParams.set("fields", "nextPageToken, files(id, name, size, modifiedTime)");
			url.searchParams.set("orderBy", "createdTime");
			url.searchParams.set("pageSize", "1000");
			url.searchParams.set("spaces", "drive");
			if (pageToken) url.searchParams.set("pageToken", pageToken);
			const res = await call(url.toString(), { method: "GET" });
			if (!res.ok) throw failure(what, res);
			const page = json<{ files?: DriveFile[]; nextPageToken?: string }>(res);
			found.push(...(page.files ?? []));
			pageToken = page.nextPageToken;
		} while (pageToken);
		return found;
	}

	/** The files (not folders) named `name` in a folder. */
	const filesNamed = (what: string, parent: string, name: string) =>
		query(
			what,
			`name = ${quote(name)} and ${quote(parent)} in parents and mimeType != ${quote(FOLDER)}`,
		);

	/** The id of a folder path under My Drive, created as needed, or null when absent. `what` names
	 * the operation it is for, so a failure here reads as that operation's. */
	async function folderId(what: string, path: string[], create: boolean): Promise<string | null> {
		let parent = "root";
		for (let i = 0; i < path.length; i++) {
			const at = path.slice(0, i + 1).join("/");
			let id = folders.get(at);
			if (!id) {
				const name = path[i]!;
				const q = `name = ${quote(name)} and ${quote(parent)} in parents and mimeType = ${quote(FOLDER)}`;
				id = (await query(what, q))[0]?.id;
				if (!id) {
					if (!create) return null;
					const res = await call(`${API}?fields=id`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: encode({ name, mimeType: FOLDER, parents: [parent] }),
					});
					if (!res.ok) throw failure(what, res);
					id = json<DriveFile>(res).id;
				}
				folders.set(at, id);
			}
			parent = id;
		}
		return parent;
	}

	/** A key's folder path and file name. */
	function locate(key: string): { folder: string[]; name: string } {
		const parts = segments(key);
		return { folder: [...base, ...parts.slice(0, -1)], name: parts.at(-1) ?? "" };
	}

	async function existing(key: string, what: string): Promise<DriveFile[]> {
		const { folder, name } = locate(key);
		const parent = await folderId(what, folder, false);
		return parent ? filesNamed(what, parent, name) : [];
	}

	return {
		async put(key, body, contentType) {
			const { folder, name } = locate(key);
			const parent = (await folderId("upload", folder, true))!;
			const [current] = await filesNamed("upload", parent, name);
			const type = contentType ?? "application/octet-stream";
			const headers = {
				"Content-Type": "application/json; charset=UTF-8",
				"X-Upload-Content-Type": type,
				"X-Upload-Content-Length": String(body.size),
			};
			// Drive allows two files with one name, so a key that exists is updated in place.
			const started = current
				? await call(`${UPLOAD}/${current.id}?uploadType=resumable`, {
						method: "PATCH",
						headers,
						body: encode({}),
					})
				: await call(`${UPLOAD}?uploadType=resumable`, {
						method: "POST",
						headers,
						body: encode({ name, parents: [parent] }),
					});
			if (!started.ok) throw failure("upload", started);
			const session = started.headers?.location;
			if (!session) throw new Error("Google Drive upload failed (no upload session was opened)");
			// One request for the whole body. Sending it in parts makes Drive answer each with a 308,
			// which every transport here turns into an opaque status 0 (`redirect: "manual"`). The
			// file appears only when the body is complete, so a cut-off upload leaves nothing.
			const res = await call(session, {
				method: "PUT",
				headers: { "Content-Type": type },
				body: body.size < PART_SIZE ? await readAll(body) : body,
			});
			if (!res.ok) throw failure("upload", res);
		},
		async get(key) {
			const [file] = await existing(key, "download");
			if (!file) throw new Error(`Google Drive download failed (not found: ${key})`);
			const res = await call(`${API}/${file.id}?alt=media`, { method: "GET" });
			if (!res.ok) throw failure("download", res);
			return res.body;
		},
		async list(prefixArg) {
			const parent = await folderId("list", [...base, ...segments(prefixArg)], false);
			if (!parent) return [];
			const files = await query(
				"list",
				`${quote(parent)} in parents and mimeType != ${quote(FOLDER)}`,
			);
			return files
				.filter((f) => f.name)
				.map(
					(f): BackupObject => ({
						key: `${prefixArg}${f.name}`,
						size: Number(f.size ?? 0),
						lastModified: f.modifiedTime,
					}),
				);
		},
		async remove(key) {
			// Permanent, not to the trash, like every other provider's delete. Any duplicates of the
			// name go too. A file already gone is fine: delete is idempotent.
			for (const file of await existing(key, "delete")) {
				const res = await call(`${API}/${file.id}`, { method: "DELETE" });
				if (!res.ok && res.status !== 404) throw failure("delete", res);
			}
		},
	};
}
