// The hosted body store: every message and blob body lives in R2 (D1 holds metadata only). Keys are
// built only from validated ids, as in every store.

import { type BodyStore, HashMismatchError } from "../core/bodies.ts";

const PAGE = 1000;

/** R2's refusal of bytes that don't match the checksum it was handed. */
const isChecksumRefusal = (err: unknown) =>
	err instanceof Error && /checksum|digest|sha-?256/i.test(err.message);

export function r2Bodies(bucket: R2Bucket, opts: { pageSize?: number } = {}): BodyStore {
	const pageSize = opts.pageSize ?? PAGE;
	return {
		async put(key, body, { sha256, size } = {}) {
			let value: ReadableStream<Uint8Array> | Uint8Array = body;
			let piping: Promise<void> = Promise.resolve();
			if (!(body instanceof Uint8Array)) {
				if (size === undefined) throw new Error("a streamed body needs its size");
				// R2 takes only a stream of known length; the core's counting stream has none. This one
				// also errors if the body comes out shorter or longer than declared.
				const fixed = new FixedLengthStream(size);
				piping = body.pipeTo(fixed.writable);
				value = fixed.readable;
			}
			const [piped, stored] = await Promise.allSettled([
				piping,
				bucket.put(key, value, sha256 ? { sha256 } : undefined),
			]);
			// A failed put stores nothing (R2 puts are atomic), and the key may hold another request's
			// good body, so nothing is deleted here. A body that landed without a row is an orphan the
			// sweep removes.
			if (piped.status === "rejected") throw piped.reason;
			if (stored.status === "rejected") {
				if (sha256 && isChecksumRefusal(stored.reason)) throw new HashMismatchError();
				throw stored.reason;
			}
		},
		async get(key) {
			const object = await bucket.get(key);
			return object ? { body: object.body, size: object.size } : null;
		},
		async delete(key) {
			await bucket.delete(key);
		},
		async deleteMany(keys) {
			// R2 deletes at most 1,000 keys a call.
			for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
		},
		async *keys(startAfter) {
			let cursor: string | undefined;
			do {
				const page = await bucket.list({
					limit: pageSize,
					...(cursor ? { cursor } : startAfter ? { startAfter } : {}),
				});
				for (const object of page.objects) {
					yield { key: object.key, modifiedAt: object.uploaded.getTime() };
				}
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
		},
	};
}
