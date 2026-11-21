import { createHash } from "node:crypto";
import { expect, test } from "./fixtures";
import { addLogin, createVault, openPopup, seedExampleLogin } from "./helpers";

// Logins saved while breach checks were off used to stay unchecked until each was opened, so the
// At Risk count said nothing about them. Turning checks on now checks them in the background.

// addLogin's password. The range answer lists it, so that login reads as breached.
const LEAKED = "hunter2-c0rrect-h0rse";

test("turning on breach checks checks logins nobody opened", async ({ context, extensionId }) => {
	const leaked = createHash("sha1").update(LEAKED).digest("hex").toUpperCase();
	const prefixes: string[] = [];
	await context.route("https://api.pwnedpasswords.com/range/*", (route) => {
		const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
		if (route.request().method() === "OPTIONS")
			return route.fulfill({ status: 204, headers: cors });
		const prefix = new URL(route.request().url()).pathname.split("/").pop() ?? "";
		prefixes.push(prefix);
		const body = leaked.startsWith(prefix) ? `${leaked.slice(5)}:42\r\n` : "";
		return route.fulfill({ status: 200, headers: cors, contentType: "text/plain", body });
	});

	await createVault(await context.newPage(), extensionId);
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await seedExampleLogin(popup);
	await addLogin(popup, "Leaky Login");
	expect(prefixes).toEqual([]);

	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "General", exact: true }).click();
	await popup.getByRole("button", { name: "Toggle breach checks" }).click();
	await expect.poll(() => prefixes.length).toBe(2);

	await popup.getByRole("button", { name: "Go back" }).click();
	await expect(popup.getByText("Breached", { exact: true })).toHaveCount(1);
	await popup.getByText("Example Login").click();
	await expect(popup.getByText("Checked for breaches just now")).toBeVisible();
});
