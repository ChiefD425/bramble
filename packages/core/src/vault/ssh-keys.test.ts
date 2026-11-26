import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { toSshKeys } from "./ssh-keys";

const ssh = (id: string, over: Record<string, unknown> = {}): Entry =>
	({
		id,
		type: "ssh-key",
		name: `key ${id}`,
		publicKey: "",
		privateKey: `PRIVATE ${id}`,
		...over,
	}) as Entry;

describe("toSshKeys", () => {
	it("projects only live SSH keys the agent may use", () => {
		const entries = [
			{ id: "l", type: "login", name: "L", urls: [], username: "u", password: "p" } as Entry,
			ssh("archived", { archivedAt: 5 }),
			ssh("empty", { privateKey: "" }),
			ssh("off", { agentDisabled: true }),
			ssh("ok", { passphrase: "pp" }),
		];
		expect(toSshKeys(entries)).toEqual([
			{ id: "ok", name: "key ok", privateKey: "PRIVATE ok", passphrase: "pp", hosts: [] },
		]);
	});

	it("orders by last use, then name", () => {
		const entries = [
			ssh("b", { name: "Bravo" }),
			ssh("old", { name: "Zulu", lastUsedAt: 10 }),
			ssh("a", { name: "Alpha" }),
			ssh("new", { name: "Yankee", lastUsedAt: 20 }),
		];
		expect(toSshKeys(entries).map((k) => k.id)).toEqual(["new", "old", "a", "b"]);
	});

	it("carries hosts, empty when none", () => {
		const [withHosts, without] = toSshKeys([
			ssh("h", { hosts: ["github.com", "10.0.0.5"] }),
			ssh("n"),
		]);
		expect(withHosts?.hosts).toEqual(["github.com", "10.0.0.5"]);
		expect(without?.hosts).toEqual([]);
	});
});
