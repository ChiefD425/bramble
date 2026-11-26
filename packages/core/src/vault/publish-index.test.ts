import { describe, expect, it, vi } from "vitest";
import type { Entry } from "../hooks/useVault";
import { publishToPlatform } from "./publish-index";

const login = {
	id: "l",
	type: "login",
	name: "GitHub",
	urls: ["https://github.com"],
	username: "u",
	password: "p",
} as Entry;
const key = { id: "k", type: "ssh-key", name: "Deploy", publicKey: "", privateKey: "PK" } as Entry;

describe("publishToPlatform", () => {
	it("sends SSH keys beside the index to an adapter that takes them", async () => {
		const setIndex = vi.fn(async () => {});
		const setSshKeys = vi.fn(async () => {});
		await publishToPlatform({ setIndex, setSshKeys }, [login, key], "lease");
		expect(setIndex).toHaveBeenCalledWith([expect.objectContaining({ id: "l" })], "lease");
		expect(setSshKeys).toHaveBeenCalledWith(
			[{ id: "k", name: "Deploy", privateKey: "PK", hosts: [] }],
			"lease",
		);
	});

	it("an adapter without setSshKeys gets the index only", async () => {
		const setIndex = vi.fn(async () => {});
		await publishToPlatform({ setIndex }, [login, key]);
		expect(setIndex).toHaveBeenCalledTimes(1);
	});

	it("no SSH keys sends an empty list", async () => {
		const setSshKeys = vi.fn(async () => {});
		await publishToPlatform({ setIndex: async () => {}, setSshKeys }, [login]);
		expect(setSshKeys).toHaveBeenCalledWith([], undefined);
	});
});
