import { describe, expect, it } from "vitest";
import raw from "../src-tauri/capabilities/default.json?raw";

describe("the main window's permissions", () => {
	it("may open web links in the browser", () => {
		// tauri-plugin-opener sends every target="_blank" link to open_url, which refuses a URL
		// outside a granted scope: without one, "Add time" and the issues link open nothing.
		const { permissions } = JSON.parse(raw) as { permissions: unknown[] };
		expect(permissions).toContainEqual({
			identifier: "opener:allow-open-url",
			allow: expect.arrayContaining([{ url: "https://*" }]),
		});
	});
});
