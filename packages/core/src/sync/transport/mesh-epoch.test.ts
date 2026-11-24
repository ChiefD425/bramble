import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSignalEvent, deriveRoomId, encryptSignal } from "..";
import { joinMesh } from "./mesh";

// The sync room changes every hour, and each device notices by its own clock, on a timer. So for a
// while around every hour one device has moved to the new room and the other has not, and each
// must still hear the other. Missing that cost e2e/sync/convergence.spec.ts every run that crossed
// an hour: a device that synced again just after it went unheard for up to a minute.

const GROUP_KEY = new Uint8Array(32).fill(7);
const LABEL = "bramble/sync";
const REMOTE = "ff".repeat(32);
const HOUR = 60 * 60 * 1000;
const BOUNDARY = Date.UTC(2026, 10, 24, 5);

const sockets: FakeSocket[] = [];

class FakeSocket {
	onopen: (() => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	readyState = 0;
	sent: string[] = [];

	constructor(public url: string) {
		sockets.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	/** The subscription the relay holds for this socket: its latest REQ. */
	private req(): [string, { "#d"?: string[] }] | null {
		for (const frame of [...this.sent].reverse()) {
			try {
				const m: unknown = JSON.parse(frame);
				if (Array.isArray(m) && m[0] === "REQ") return [m[1], m[2]];
			} catch {
				// a keepalive ping, which isn't JSON
			}
		}
		return null;
	}
	/** Deliver an event as the relay would: only into a room this socket subscribed to. */
	deliver(room: string, event: unknown): boolean {
		const req = this.req();
		if (!req?.[1]["#d"]?.includes(room)) return false;
		this.onmessage?.({ data: JSON.stringify(["EVENT", req[0], event]) });
		return true;
	}
}

const realSetTimeout = globalThis.setTimeout;
const hop = () => new Promise((r) => realSetTimeout(r, 0));
const settleUntil = async (ok: () => boolean): Promise<void> => {
	for (let i = 0; i < 500 && !ok(); i++) await hop();
};

const status: string[] = [];
const found = () => status.some((m) => m.startsWith(`peer ${REMOTE.slice(0, 8)}`));
const started: { stop: () => void }[] = [];

async function mesh(): Promise<FakeSocket> {
	const m = await joinMesh({
		relayUrl: "wss://relay.invalid",
		groupKey: GROUP_KEY,
		roomLabel: LABEL,
		epochRooms: true,
		signer: {
			pubkeyHex: "ab".repeat(32),
			signer: { pubkeyHex: "ab".repeat(32), sign: async () => "cd".repeat(32) },
			verifier: { verify: async () => true },
		},
		onStatus: (m: string) => status.push(m),
		onPeer: () => {},
	});
	started.push(m);
	const socket = sockets.at(-1)!;
	socket.open();
	await vi.advanceTimersByTimeAsync(0);
	return socket;
}

/** A hello from REMOTE, published in the room of the hour its own clock is in. */
async function helloFrom(epochMs: number, socket: FakeSocket): Promise<boolean> {
	const room = await deriveRoomId(GROUP_KEY, LABEL, Math.floor(epochMs / HOUR));
	const content = await encryptSignal(GROUP_KEY, JSON.stringify({ kind: "hello", rtc: false }));
	const event = await buildSignalEvent(
		{ pubkeyHex: REMOTE, sign: async () => "ee".repeat(32) },
		room,
		content,
		Math.floor(Date.now() / 1000),
	);
	return socket.deliver(room, event);
}

beforeEach(() => {
	sockets.length = 0;
	status.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
	vi.useFakeTimers();
});

afterEach(async () => {
	for (const m of started.splice(0)) m.stop();
	await vi.advanceTimersByTimeAsync(0);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("hears a device that has moved to the new hour before it has", async () => {
	vi.setSystemTime(BOUNDARY - 30_000);
	const socket = await mesh();
	// Ten seconds into the new hour, before this device's next check.
	await vi.advanceTimersByTimeAsync(40_000);

	expect(await helloFrom(Date.now(), socket)).toBe(true);
	await settleUntil(found);
	expect(found()).toBe(true);
});

it("hears a device that hasn't moved to the new hour yet", async () => {
	vi.setSystemTime(BOUNDARY + 10_000);
	const socket = await mesh();

	expect(await helloFrom(BOUNDARY - 1, socket)).toBe(true);
	await settleUntil(found);
	expect(found()).toBe(true);
});

it("hears a device whose clock runs ahead into the next hour", async () => {
	vi.setSystemTime(BOUNDARY - 5_000);
	const socket = await mesh();

	expect(await helloFrom(BOUNDARY + 1, socket)).toBe(true);
	await settleUntil(found);
	expect(found()).toBe(true);
});
