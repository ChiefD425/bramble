/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UnexportablePasskeyError } from "../../../../export/kdbx";
import type { EntryConflict } from "../../../../sync";
import { KdbxExportDialog } from "./KdbxExportDialog";

const h = vi.hoisted(() => ({
	conflicts: new Map<string, EntryConflict>(),
	exportKdbx: async (_password: string) => {},
}));

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({ exportKdbx: h.exportKdbx, conflicts: h.conflicts }),
}));

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

function show() {
	render(
		<I18nProvider i18n={i18n}>
			<KdbxExportDialog open onClose={() => {}} />
		</I18nProvider>,
	);
}

describe("the KeePass export dialog", () => {
	it("counts the vault's entries with other versions", () => {
		h.conflicts = new Map([
			["1", { versions: 1, deleted: false }],
			["2", { versions: 1, deleted: false }],
			["3", { versions: 0, deleted: true }],
		]);
		show();
		expect(
			screen.getByText(/2 entries have a sync conflict\. Only the version you see is exported\./),
		).toBeTruthy();
	});

	it("says nothing when no entry has another version", () => {
		h.conflicts = new Map([["3", { versions: 0, deleted: true }]]);
		show();
		expect(screen.queryByText(/sync conflict/)).toBeNull();
	});

	it("says the file carries passkeys as well as attachments", () => {
		h.conflicts = new Map();
		show();
		expect(screen.getByText(/Your attachments and passkeys go with it\./)).toBeTruthy();
	});

	it("names the entry whose damaged passkey stopped the export", async () => {
		h.conflicts = new Map();
		h.exportKdbx = async () => {
			throw new UnexportablePasskeyError("GitHub");
		};
		show();
		for (const label of ["Password for the file", "Confirm password"]) {
			fireEvent.change(screen.getByLabelText(label), { target: { value: "file-pw" } });
		}
		fireEvent.click(screen.getByRole("button", { name: "Export" }));
		expect(await screen.findByText(/A passkey on "GitHub" is damaged/)).toBeTruthy();
	});
});
