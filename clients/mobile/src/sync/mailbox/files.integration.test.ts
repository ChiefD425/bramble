import { collectBlobs, syncWants, uploadWanted } from "@core/sync/mailbox/files";
import { sha256Hex } from "@core/sync/mailbox/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLogin, attachFile, type TestDevice, testGroup } from "./test-device";
import { startTestMailbox, type TestMailbox } from "./test-server";

let box: TestMailbox;
beforeAll(async () => {
	box = await startTestMailbox();
});
afterAll(() => box.close());

/** A creates the mailbox listing everyone; the named others activate. */
async function group(names: string[], active: string[]): Promise<TestDevice[]> {
	const devices = await testGroup(box, names);
	const [first] = devices as [TestDevice];
	await first.ctx.api.create({ members: devices.map((d) => d.sigKey) });
	for (const d of devices) if (active.includes(d.name)) await d.ctx.api.activate(true);
	return devices;
}

/** `to` merges `from`'s whole vault directly, without the mailbox. */
async function mergeDirect(from: TestDevice, to: TestDevice) {
	await to.ctx.vault.apply({
		entries: await from.vault.mutations.readEntriesPayload(),
		roster: from.roster.current,
	});
}

describe("file blobs through the mailbox", () => {
	it("lists the blobs its manifest names but its store lacks", async () => {
		const [a, b] = (await group(["a", "b"], ["b"])) as [TestDevice, TestDevice];
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([1, 2, 3]));
		await mergeDirect(a, b);
		await syncWants(b.ctx, b.state, await b.vault.mutations.readEntriesPayload());
		expect(b.state.wants).toEqual([hash]);
		expect((await a.ctx.api.inbox()).wanted).toEqual([hash]);
	});

	it("uploads what another member wants and holds", async () => {
		const [a, b] = (await group(["a", "b"], ["b"])) as [TestDevice, TestDevice];
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([4, 5]));
		await uploadWanted(a.ctx, [hash, "f".repeat(64)]);
		expect((await b.ctx.api.inbox()).blobs.map((x) => x.hash)).toEqual([hash]);
	});

	it("fetches a new want directly when the mailbox already holds it", async () => {
		const [a, , c] = (await group(["a", "b", "c"], ["b"])) as [TestDevice, TestDevice, TestDevice];
		const hash = await attachFile(a, await addLogin(a, "Passport"), new Uint8Array([6, 7, 8]));
		await uploadWanted(a.ctx, [hash]);
		await c.ctx.api.activate(true);
		await mergeDirect(a, c);
		await syncWants(c.ctx, c.state, await c.vault.mutations.readEntriesPayload());
		expect(await c.blobs.has(hash)).toBe(true);
		expect(c.state.wants).toEqual([]);
	});

	it("fetches new wants directly a few at a time until every one was tried", async () => {
		const devices = await testGroup(box, ["a", "b", "c"], { limits: { directGets: 1 } });
		const [a, b, c] = devices as [TestDevice, TestDevice, TestDevice];
		await a.ctx.api.create({ members: devices.map((d) => d.sigKey) });
		await b.ctx.api.activate(true);
		const entry = await addLogin(a, "Passport");
		const one = await attachFile(a, entry, new Uint8Array([21]));
		const two = await attachFile(a, entry, new Uint8Array([22]));
		await uploadWanted(a.ctx, [one, two]);
		await c.ctx.api.activate(true);
		await mergeDirect(a, c);
		await syncWants(c.ctx, c.state, await c.vault.mutations.readEntriesPayload());
		await syncWants(c.ctx, c.state, await c.vault.mutations.readEntriesPayload());
		expect(await c.blobs.has(one)).toBe(true);
		expect(await c.blobs.has(two)).toBe(true);
	});

	it("collects a delivered blob, and acknowledges one it holds without downloading", async () => {
		const [a, b] = (await group(["a", "b"], ["b"])) as [TestDevice, TestDevice];
		const entry = await addLogin(a, "Passport");
		const fresh = await attachFile(a, entry, new Uint8Array([9]));
		const held = await attachFile(a, entry, new Uint8Array([10]));
		await b.blobs.put(held, new Uint8Array([10]));
		await uploadWanted(a.ctx, [fresh, held]);

		const downloads: string[] = [];
		const mover = b.ctx.blobs.mover;
		b.ctx.blobs.mover = {
			upload: mover.upload,
			download: (hash, req) => {
				downloads.push(hash);
				return mover.download(hash, req);
			},
		};
		const acked = await collectBlobs(b.ctx, (await b.ctx.api.inbox()).blobs);
		expect(acked.sort()).toEqual([fresh, held].sort());
		expect(downloads).toEqual([fresh]);
		expect(await b.blobs.read(fresh)).toEqual(new Uint8Array([9]));
		expect(await sha256Hex(await b.blobs.read(held))).toBe(held);
	});
});
