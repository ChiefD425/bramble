import { describe, expect, it } from "vitest";
import { startTestMailbox } from "./test-server";

describe("test mailbox server", () => {
	it("serves the mailbox on a fake clock the test can move", async () => {
		const box = await startTestMailbox();
		try {
			expect(await (await fetch(`${box.url}/health`)).text()).toBe("ok");
			const now = async () => Number(await (await fetch(`${box.url}/__test/now`)).text());
			const before = await now();
			await box.advance(86_400_000);
			expect(await now()).toBe(before + 86_400_000);
		} finally {
			await box.close();
		}
	});
});
