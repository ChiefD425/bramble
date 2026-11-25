// Test-only: an in-memory server with a fake clock, and devices that sign requests the way the
// apps will (an Ed25519 roster key over canonicalRequest).

import type { BodyStore } from "../core/bodies.ts";
import { deviceWith } from "./device.ts";
import { makeServer, type ServerOpts, type TestServer } from "./memory.ts";

export * from "./device.ts";
export { makeServer, memoryBodies, type ServerOpts, type TestServer } from "./memory.ts";

/** Against the in-memory server, on its fake clock. */
export const makeDevice = (server: TestServer) =>
	deviceWith(
		() => server.clock.now,
		(path, init) => server.app.request(path, init),
	);

/** A server and `n` devices, each with its own key. */
export async function setup(n: number, opts: ServerOpts = {}) {
	const server = makeServer(opts);
	const devices = await Promise.all(Array.from({ length: n }, () => makeDevice(server)));
	return { server, devices };
}

/**
 * A body store whose `put` can be held open, to change membership while an upload is in flight:
 * `hold()`, start the request, `await entered()`, act, then `release()`.
 */
export function gatedBodies() {
	let gate: Promise<void> | null = null;
	let open = () => {};
	let arrived = () => {};
	let entered: Promise<void> = Promise.resolve();
	return {
		wrap(inner: BodyStore): BodyStore {
			return {
				...inner,
				async put(key, body, opts) {
					if (gate) {
						arrived();
						await gate;
					}
					return inner.put(key, body, opts);
				},
			};
		},
		hold() {
			gate = new Promise((resolve) => {
				open = resolve;
			});
			entered = new Promise((resolve) => {
				arrived = resolve;
			});
		},
		entered: () => entered,
		release() {
			gate = null;
			open();
		},
	};
}
