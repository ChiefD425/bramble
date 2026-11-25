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
	it("hosts round-trip one per line", () => {
		const entry = { ...KEY, hosts: ["github.com", "*.example.com"] };
		expect(sshKeyMode.toForm(entry).hosts).toBe("github.com\n*.example.com");
		expect((sshKeyMode.toEntry(sshKeyMode.toForm(entry)) as SshKeyEntryData).hosts).toEqual([
			"github.com",
			"*.example.com",
		]);
	});

	it("user@ is stripped and a bad host shows the error", async () => {
		mount();
		const hosts = screen.getByLabelText("Hosts (optional)");
		fireEvent.change(hosts, { target: { value: "git@github.com\n\n10.0.0.5" } });
		let ok = false;
		await act(async () => {
			ok = await form.trigger("hosts");
		});
		expect(ok).toBe(true);
		expect(save().hosts).toEqual(["github.com", "10.0.0.5"]);

		fireEvent.change(hosts, { target: { value: "github.com\na b" } });
		await act(async () => {
			ok = await form.trigger("hosts");
		});
		expect(ok).toBe(false);
		expect(await screen.findByText("Use only the host, like github.com or 10.0.0.5")).toBeTruthy();
	});

	it("clearing every host clears the field", () => {
		const cleared = sshKeyMode.toEntry({
			...sshKeyMode.toForm({ ...KEY, hosts: ["a"] }),
			hosts: "",
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
		expect(sshKeyMode.toForm(odd).hosts).toBe("");
		expect(toSshKeys([odd as never])[0]?.hosts).toEqual([]);
	});

	it("search matches a host", () => {
		const entry = { ...KEY, id: "k", hosts: ["bastion.example"] };
		expect(sshKeyMode.searchText?.(entry as never)).toContain("bastion.example");
	});

	it("the entry page lists the hosts and says when the agent is off", () => {
		const Detail = sshKeyMode.Detail;
		const entry = { ...KEY, id: "k", hosts: ["github.com", "10.0.0.5"], agentDisabled: true };
		render(
			<I18nProvider i18n={i18n}>
				<Detail
					entry={entry as unknown as EntryDetailBodyProps["entry"]}
					copied={null}
					copy={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("github.com, 10.0.0.5")).toBeTruthy();
		expect(screen.getByText("Not used by the SSH agent")).toBeTruthy();
	});
});
