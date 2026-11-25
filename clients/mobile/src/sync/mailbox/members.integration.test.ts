import { ensureActive, reconcileMembers, switchOff } from "@core/sync/mailbox/members";
import { revokeDevice } from "@core/sync/roster";
import { ed25519Signer } from "@core/test/mailbox-fakes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDevice, testGroup } from "./test-device";
import { startTestMailbox, type TestMailbox } from "./test-server";

let box: TestMailbox;
beforeAll(async () => {
	box = await startTestMailbox();
});
afterAll(() => box.close());

async function statuses(d: TestDevice): Promise<Record<string, string>> {
	const { members } = await d.ctx.api.members();
	return Object.fromEntries(members.map((m) => [m.sigKey, m.status]));
}

describe("membership", () => {
	it("the first device creates the mailbox with every active roster device eligible", async () => {
		const [a, b, c, d] = (await testGroup(box, ["a", "b", "c", "d"])) as TestDevice[] as [
			TestDevice,
			TestDevice,
			TestDevice,
			TestDevice,
		];
		a.roster.current = revokeDevice(a.roster.current, "d", { wall: 2, counter: 0, node: "a" });
		expect(await ensureActive(a.ctx, a.state, a.roster.current)).toBe("active");
		expect(await statuses(a)).toEqual({
			[a.sigKey]: "active",
			[b.sigKey]: "eligible",
			[c.sigKey]: "eligible",
		});
		expect(d.sigKey in (await statuses(a))).toBe(false);
		expect(a.state).toMatchObject({ active: true, catchUp: false });
	});

	it("a later device activates and asks for a catch-up", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		await ensureActive(a.ctx, a.state, a.roster.current);
		expect(await ensureActive(b.ctx, b.state, b.roster.current)).toBe("active");
		expect(b.state).toMatchObject({ active: true, catchUp: true });
		expect((await statuses(a))[b.sigKey]).toBe("active");
	});

	it("a device no member has listed waits", async () => {
		const [a, b, e] = (await testGroup(box, ["a", "b", "e"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		await a.ctx.api.create({ members: [a.sigKey, b.sigKey] });
		expect(await ensureActive(e.ctx, e.state, e.roster.current)).toBe("waiting");
		expect(e.state.active).toBe(false);
	});

	it("reconciliation adds roster devices and removes every other key", async () => {
		const [a, b, c] = (await testGroup(box, ["a", "b", "c"])) as [
			TestDevice,
			TestDevice,
			TestDevice,
		];
		const stranger = await ed25519Signer();
		await a.ctx.api.create({ members: [a.sigKey, b.sigKey] });
		await a.ctx.api.changeMembers({ add: [stranger.sigKey], remove: [] });
		a.state.active = true;
		await reconcileMembers(a.ctx, a.state, a.roster.current);
		expect(await statuses(a)).toEqual({
			[a.sigKey]: "active",
			[b.sigKey]: "eligible",
			[c.sigKey]: "eligible",
		});
	});

	it("switching off deactivates but stays eligible", async () => {
		const [a, b] = (await testGroup(box, ["a", "b"])) as [TestDevice, TestDevice];
		await ensureActive(a.ctx, a.state, a.roster.current);
		await ensureActive(b.ctx, b.state, b.roster.current);
		await switchOff(b.ctx, b.state);
		expect(b.state.active).toBe(false);
		expect((await statuses(a))[b.sigKey]).toBe("eligible");
	});
});
