import { describe, expect, it } from "vitest";
import type { PendingNewLogin } from "../adapters/shell";
import type { Entry, LoginEntry } from "../hooks/useVault";
import { planPendingLogins } from "./pending-login";

function login(id: string, overrides: Partial<LoginEntry> = {}): LoginEntry {
	return {
		id,
		type: "login",
		name: `entry-${id}`,
		urls: [],
		username: "me@example.com",
		password: "pw",
		...overrides,
	} as LoginEntry;
}

function pending(key: string, overrides: Partial<PendingNewLogin> = {}): PendingNewLogin {
	return {
		key,
		name: "example.com",
		url: "https://example.com",
		username: "me@example.com",
		password: `generated-${key}`,
		...overrides,
	};
}

describe("planPendingLogins", () => {
	it("turns a login made in the picker into a new login entry", () => {
		const out = planPendingLogins([], [pending("a")]);
		expect(out.done).toEqual([]);
		expect(out.add).toEqual([
			{
				key: "a",
				data: {
					type: "login",
					name: "example.com",
					urls: ["https://example.com"],
					username: "me@example.com",
					password: "generated-a",
				},
			},
		]);
	});

	it("keeps an app's androidapp:// identity as the login's url", () => {
		const out = planPendingLogins(
			[],
			[pending("a", { name: "Spotify", url: "androidapp://com.spotify.music" })],
		);
		expect(out.add[0]!.data.urls).toEqual(["androidapp://com.spotify.music"]);
		expect(out.add[0]!.data.name).toBe("Spotify");
	});

	it("saves a login with no site, named after its username", () => {
		const out = planPendingLogins([], [pending("a", { name: "  ", url: "" })]);
		expect(out.add[0]!.data.urls).toEqual([]);
		expect(out.add[0]!.data.name).toBe("me@example.com");
	});

	it("falls back to the site's host when the name is blank", () => {
		const out = planPendingLogins(
			[],
			[pending("a", { name: "", url: "https://www.acme.test/signup" })],
		);
		expect(out.add[0]!.data.name).toBe("www.acme.test");
	});

	// An earlier drain saved it and was stopped before it could remove it from the queue.
	it("marks one already in the vault as done instead of adding it twice", () => {
		const entries: Entry[] = [login("e1", { username: "me@example.com", password: "generated-a" })];
		const out = planPendingLogins(entries, [pending("a"), pending("b")]);
		expect(out.done).toEqual(["a"]);
		expect(out.add.map((a) => a.key)).toEqual(["b"]);
	});

	it("still adds one whose password matches a login with another username", () => {
		const entries: Entry[] = [
			login("e1", { username: "someone@else.test", password: "generated-a" }),
		];
		expect(planPendingLogins(entries, [pending("a")]).add.map((a) => a.key)).toEqual(["a"]);
	});

	it("adds the same login queued twice only once", () => {
		const out = planPendingLogins([], [pending("a"), pending("b", { password: "generated-a" })]);
		expect(out.add.map((a) => a.key)).toEqual(["a"]);
		expect(out.done).toEqual(["b"]);
	});

	it("never treats a passwordless login as a duplicate", () => {
		const entries: Entry[] = [login("e1", { password: "" })];
		const out = planPendingLogins(entries, [pending("a", { password: "" })]);
		expect(out.add.map((a) => a.key)).toEqual(["a"]);
	});

	it("does nothing with nothing pending", () => {
		expect(planPendingLogins([login("e1")], [])).toEqual({ add: [], done: [] });
	});
});
