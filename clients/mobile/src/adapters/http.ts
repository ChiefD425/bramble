import { Capacitor, registerPlugin } from "@capacitor/core";
import {
	fetchTransport,
	type HttpResponse,
	type HttpTransport,
	TRANSFER_INTERRUPTED,
} from "@core/adapters/http";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { dropSpooled, spoolToCache } from "./spool";

// Outbound HTTP for hosts the WebView cannot reach. Its origin is `capacitor://localhost` on iOS
// and `https://localhost` on Android, which an API that sends no CORS headers grants nothing, so
// those requests leave from the native side. The two rules (no ambient cookies, no redirect
// following) are kept over there, because that is where the request actually happens, and because
// on both platforms the stock HTTP client breaks them. See NativeHttp.swift / NativeHttpPlugin.kt
// and @core/adapters/http.

interface NativeHttpPlugin {
	/** Bodies cross as base64 both ways: the bridge is JSON, which has no byte arrays. */
	send(options: {
		method: string;
		url: string;
		headers: Record<string, string>;
		body?: string;
	}): Promise<{ status: number; body: string }>;
	/** `send` with the body streamed from a file, for one too large to cross the bridge. */
	sendFile(options: {
		method: string;
		url: string;
		headers: Record<string, string>;
		path: string;
	}): Promise<{ status: number; body: string }>;
	/** The response body streamed into the file at `path`, whatever the status, with the SHA-256
	 * (hex) of what was written, so a large download never crosses the bridge. */
	download(options: {
		method: string;
		url: string;
		headers: Record<string, string>;
		path: string;
	}): Promise<{ status: number; sha256: string }>;
}

const Native = registerPlugin<NativeHttpPlugin>("NativeHttp");

/**
 * Bramble was left and the OS stopped it: iOS's background time ran out, or Android's foreground
 * service could not hold. Named as such, so a backup is retried rather than backed off from, and
 * an alias gets an honest message.
 */
function named(e: unknown): unknown {
	return (e as { code?: string } | null)?.code === "interrupted"
		? new Error(TRANSFER_INTERRUPTED)
		: e;
}

const nativeTransport: HttpTransport = {
	async send({ method, url, headers, body }): Promise<HttpResponse> {
		let res: { status: number; body: string };
		// A body already in a file on this device (a stored attachment) is sent from that file.
		const file = body && !(body instanceof Uint8Array) ? body.path : undefined;
		// A body too large for one bridge call (a large WebDAV backup) is spooled to a file a chunk
		// at a time and sent from there; the native side declares its full length.
		const spooled =
			body && !(body instanceof Uint8Array) && !file
				? `.upload-${globalThis.crypto.randomUUID()}`
				: null;
		try {
			if (file) {
				res = await Native.sendFile({ method, url, headers: headers ?? {}, path: file });
			} else if (spooled && body && !(body instanceof Uint8Array)) {
				const { path } = await spoolToCache(spooled, body);
				res = await Native.sendFile({ method, url, headers: headers ?? {}, path });
			} else {
				res = await Native.send({
					method,
					url,
					headers: headers ?? {},
					// Omitted rather than sent empty, so the native side can tell "no body" from "a body
					// that happens to be zero bytes" and pick the right thing for the method.
					...(body instanceof Uint8Array ? { body: bytesToBase64(body) } : {}),
				});
			}
		} catch (e) {
			throw named(e);
		} finally {
			if (spooled) await dropSpooled(spooled);
		}
		return {
			status: res.status,
			ok: res.status >= 200 && res.status < 300,
			body: res.body ? base64ToBytes(res.body) : new Uint8Array(),
		};
	},
};

/** A response body downloaded natively into the file at `path`, hashed as written. Native only:
 * the caller checks the hash before trusting the file. */
export async function nativeDownload(
	req: { method: string; url: string; headers?: Record<string, string> },
	path: string,
): Promise<{ status: number; sha256: string }> {
	try {
		return await Native.download({
			method: req.method,
			url: req.url,
			headers: req.headers ?? {},
			path,
		});
	} catch (e) {
		throw named(e);
	}
}

/**
 * The native transport on a device, plain `fetch` in the dev browser.
 *
 * A platform guard rather than a try/catch, because a transport that quietly degrades is worse
 * than one that fails: falling back to `fetch` on a device would put the request back inside the
 * WebView, where the CORS-less hosts this exists for cannot be reached and the cookie rules do
 * not hold. `pnpm dev` has no native plugin and also no CORS problem, so there the fallback is
 * both necessary and correct.
 *
 * Decided per call, not at module load: `isNativePlatform()` reads the injected bridge and
 * answers "web" until it is there, so freezing it here could bake in the wrong answer for the
 * life of the process (the same trap `adapters/biometric` documents for `getPlatform`).
 */
export const mobileHttp: HttpTransport = {
	send: (req) => (Capacitor.isNativePlatform() ? nativeTransport : fetchTransport).send(req),
};
