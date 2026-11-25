import { afterEach, describe, expect, it, vi } from "vitest";
import { withVaultWriteLock } from "./write-lock";

function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** A stand-in for the browser's Web Locks: one holder per name, in request order. */
function stubLocks(): string[] {
	const names: string[] = [];
	const chains = new Map<string, Promise<unknown>>();
	const request = (name: string, run: () => Promise<unknown>) => {
		names.push(name);
		const next = (chains.get(name) ?? Promise.resolve()).then(run);
		chains.set(
			name,
			next.catch(() => {}),
		);
		return next;
	};
	vi.stubGlobal("navigator", { locks: { request } });
	return names;
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
	["without navigator.locks", () => vi.stubGlobal("navigator", {})],
	["with navigator.locks", () => void stubLocks()],
])("withVaultWriteLock, %s", (_name, install) => {
	it("runs one writer at a time", async () => {
		install();
		const g = gate();
		const order: string[] = [];
		const first = withVaultWriteLock(async () => {
			order.push("first:start");
			await g.opened;
			order.push("first:end");
		});
		const second = withVaultWriteLock(async () => {
			order.push("second:start");
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual(["first:start"]);
		g.open();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("lets go after a writer throws", async () => {
		install();
		await expect(
			withVaultWriteLock(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(withVaultWriteLock(async () => "done")).resolves.toBe("done");
	});
});

it("asks the browser for one lock, bramble:vault-write", async () => {
	const names = stubLocks();
	await withVaultWriteLock(async () => {});
	expect(names).toEqual(["bramble:vault-write"]);
});
