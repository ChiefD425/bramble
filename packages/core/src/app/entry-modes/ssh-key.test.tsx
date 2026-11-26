/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type FieldValues, FormProvider, type UseFormReturn, useForm } from "react-hook-form";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SshKeyEntryData } from "../../hooks/useVault";
import { toSshKeys } from "../../vault/ssh-keys";
import { sshKeyMode } from "./ssh-key";
import type { EntryDetailBodyProps } from "./types";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const KEY: SshKeyEntryData = {
	type: "ssh-key",
	name: "Deploy",
	publicKey: "ssh-ed25519 AAAA",
	privateKey: "PRIVATE",
};

let form: UseFormReturn<FieldValues>;

function Host({ entry }: { entry: SshKeyEntryData }) {
	form = useForm<FieldValues>({ defaultValues: sshKeyMode.toForm(entry) });
	const Fields = sshKeyMode.Fields;
	return (
		<FormProvider {...form}>
			<Fields />
		</FormProvider>
	);
}

function mount(entry = KEY) {
	render(
		<I18nProvider i18n={i18n}>
			<Host entry={entry} />
		</I18nProvider>,
	);
}

const save = () => sshKeyMode.toEntry(form.getValues()) as SshKeyEntryData;

describe("SSH key hosts and agent switch", () => {
	it("hosts round-trip as one row each", () => {
		const entry = { ...KEY, hosts: ["github.com", "*.example.com"] };
		expect(sshKeyMode.toForm(entry).hosts).toEqual([
			{ value: "github.com" },
			{ value: "*.example.com" },
		]);
		expect((sshKeyMode.toEntry(sshKeyMode.toForm(entry)) as SshKeyEntryData).hosts).toEqual([
			"github.com",
			"*.example.com",
		]);
	});

	it("Add host adds a row; user@ is stripped, empty rows dropped, a bad host flagged", async () => {
		mount();
		expect(screen.queryByLabelText("Host")).toBeNull();
		const add = screen.getByRole("button", { name: "Add host" });
		fireEvent.click(add);
		fireEvent.click(add);
		fireEvent.click(add);
		const rows = screen.getAllByLabelText("Host");
		expect(rows).toHaveLength(3);
		fireEvent.change(rows[0]!, { target: { value: "git@github.com" } });
		fireEvent.change(rows[1]!, { target: { value: "a b" } });
		let ok = true;
		await act(async () => {
			ok = await form.trigger("hosts");
		});
		expect(ok).toBe(false);
		expect(await screen.findByText("Use only the host, like github.com or 10.0.0.5")).toBeTruthy();

		fireEvent.change(rows[1]!, { target: { value: "10.0.0.5" } });
		await act(async () => {
			ok = await form.trigger("hosts");
		});
		expect(ok).toBe(true);
		expect(save().hosts).toEqual(["github.com", "10.0.0.5"]);
	});

	// Hosts are what changes after a key is pasted, so they sit first, as a login's Websites do.
	it("the form puts Hosts right after the name", () => {
		mount();
		const hosts = screen.getByText("Hosts");
		const name = screen.getByLabelText("Name");
		const publicKey = screen.getByLabelText("Public key");
		expect(name.compareDocumentPosition(hosts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(
			hosts.compareDocumentPosition(publicKey) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("the entry page shows the hosts first", () => {
		const Detail = sshKeyMode.Detail;
		const entry = { ...KEY, id: "k", hosts: ["github.com"] };
		render(
			<I18nProvider i18n={i18n}>
				<Detail
					entry={entry as unknown as EntryDetailBodyProps["entry"]}
					copied={null}
					copy={vi.fn()}
				/>
			</I18nProvider>,
		);
		const host = screen.getByText("github.com");
		const publicKey = screen.getByText("Public key");
		expect(host.compareDocumentPosition(publicKey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("Remove host takes out its row", () => {
		mount({ ...KEY, hosts: ["a.example", "b.example"] });
		fireEvent.click(screen.getAllByRole("button", { name: "Remove host" })[0]!);
		expect(save().hosts).toEqual(["b.example"]);
	});

	it("clearing every host clears the field", () => {
		const cleared = sshKeyMode.toEntry({
			...sshKeyMode.toForm({ ...KEY, hosts: ["a"] }),
			hosts: [],
		});
		expect(cleared).toHaveProperty("hosts", undefined);
	});

	it("the switch stores agentDisabled only when off", () => {
		mount();
		expect(save().agentDisabled).toBeUndefined();
		expect(save()).toHaveProperty("agentDisabled");
		fireEvent.click(screen.getByRole("button", { name: "Use with the SSH agent" }));
		expect(save().agentDisabled).toBe(true);
		expect(sshKeyMode.toForm({ ...KEY, agentDisabled: true }).useAgent).toBe(false);
	});

	it("a hosts value that isn't a list breaks nothing", () => {
		const odd = { ...KEY, id: "k", hosts: "github.com" } as unknown as SshKeyEntryData;
		expect(() => sshKeyMode.searchText?.(odd as never)).not.toThrow();
		expect(sshKeyMode.toForm(odd).hosts).toEqual([]);
		expect(toSshKeys([odd as never])[0]?.hosts).toEqual([]);
	});

	it("search matches a host", () => {
		const entry = { ...KEY, id: "k", hosts: ["bastion.example"] };
		expect(sshKeyMode.searchText?.(entry as never)).toContain("bastion.example");
	});

	it("the entry page lists the hosts and says when the agent is off", () => {
		const Detail = sshKeyMode.Detail;
		const entry = { ...KEY, id: "k", hosts: ["github.com", "10.0.0.5"], agentDisabled: true };
		const copy = vi.fn();
		render(
			<I18nProvider i18n={i18n}>
				<Detail
					entry={entry as unknown as EntryDetailBodyProps["entry"]}
					copied={null}
					copy={copy}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("Hosts")).toBeTruthy();
		expect(screen.getByText("github.com")).toBeTruthy();
		expect(screen.getByText("10.0.0.5")).toBeTruthy();
		fireEvent.click(screen.getAllByRole("button", { name: "Copy host" })[1]!);
		expect(copy).toHaveBeenCalledWith("host-1", "10.0.0.5");
		expect(screen.getByText("Not used by the SSH agent")).toBeTruthy();
	});
});
