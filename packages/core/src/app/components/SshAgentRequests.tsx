import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef } from "react";
import type { SshAgentRequest } from "../../adapters/ssh-agent";
import { useSshAgentRequests } from "../../hooks/useSshAgentRequests";
import { useVault, useVaultActions } from "../../hooks/useVault";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import { displayLabel } from "../../vault/vault-registry";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

/** A key or vault name, picked out from the sentence around it. */
function Name({ children }: { children: ReactNode }) {
	return <strong className="font-medium text-foreground">{children}</strong>;
}

/** Who wants what, in one line. The caller's name is only a label: any program can claim one. */
export function requestLine(r: SshAgentRequest): ReactNode {
	const { caller, keyName, server } = r;
	if (!keyName) {
		const who = server ?? caller;
		return <Trans>{who} wants to use your SSH keys</Trans>;
	}
	if (server)
		return (
			<Trans>
				{server} wants to use <Name>{keyName}</Name>
			</Trans>
		);
	switch (r.purpose) {
		case "git":
			return (
				<Trans>
					{caller} wants to sign a git commit with <Name>{keyName}</Name>
				</Trans>
			);
		case "message":
			return (
				<Trans>
					{caller} wants to sign a message with <Name>{keyName}</Name>
				</Trans>
			);
		default:
			return (
				<Trans>
					{caller} wants to sign in to a server with <Name>{keyName}</Name>
				</Trans>
			);
	}
}

/** The agent's questions while a vault is open: open another vault, allow one use, or allow a
 * server reached with `ssh -A`. While locked it only puts the right vault on the unlock screen,
 * where `SshAgentRequestLine` says who asked. See docs/ssh-agent.md. */
export function SshAgentRequests() {
	const { current, answer } = useSshAgentRequests();
	const { isLocked } = useVault();
	const { lock } = useVaultActions();
	const { activeId, vaults, selectVault } = useVaultRegistry();
	const { t } = useLingui();

	// Once per request: picking another vault on the unlock screen is the user's choice.
	const selectedFor = useRef<string | null>(null);
	const wanted = current?.vaultId;
	const requestId = current?.id;
	useEffect(() => {
		if (!isLocked || !wanted || !requestId || selectedFor.current === requestId) return;
		selectedFor.current = requestId;
		if (wanted !== activeId && vaults.some((v) => v.id === wanted)) selectVault(wanted);
	}, [isLocked, wanted, requestId, activeId, vaults, selectVault]);

	if (!current || isLocked) return null;

	const openIndex = vaults.findIndex((v) => v.id === activeId);
	const openVault = openIndex >= 0 ? displayLabel(vaults[openIndex]!, openIndex) : "";
	const vaultName = current.vaultName ?? "";
	const keyName = current.keyName ?? "";
	const caller = current.caller;
	const card = (title: string, body: ReactNode, yes: string, onYes: () => void, no: string) => (
		<Modal open onClose={() => void answer(false)} className="max-w-sm">
			<div className="p-6 space-y-4">
				<h2 className="text-base font-medium">{title}</h2>
				<p className="text-sm text-muted-foreground">{body}</p>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => void answer(false)}>
						{no}
					</Button>
					<Button onClick={onYes}>{yes}</Button>
				</div>
			</div>
		</Modal>
	);

	switch (current.mode) {
		case "switch":
			return card(
				t`Open ${vaultName}?`,
				<Trans>
					{caller} wants to use <Name>{keyName}</Name> from <Name>{vaultName}</Name>.{" "}
					<Name>{openVault}</Name> will lock.
				</Trans>,
				t`Open ${vaultName}`,
				() =>
					void (async () => {
						// Locked first: the app holds one vault's key at a time.
						await lock();
						if (current.vaultId) selectVault(current.vaultId);
					})(),
				t`Cancel`,
			);
		case "confirm":
			return card(
				t`Allow this use of ${keyName}?`,
				requestLine(current),
				t`Allow`,
				() => void answer(true),
				t`Deny`,
			);
		case "allow-server": {
			const server = current.server ?? "";
			return card(
				t`Let ${server} use your SSH keys?`,
				t`A server you're connected to with ssh -A wants to see and use your keys until Bramble locks.`,
				t`Allow`,
				() => void answer(true),
				t`Deny`,
			);
		}
		default:
			return null;
	}
}

/** Above the unlock form: who asked for a key from this vault, and a way to say no. */
export function SshAgentRequestLine() {
	const { current, answer } = useSshAgentRequests();
	const { isLocked } = useVault();
	const { activeId } = useVaultRegistry();
	const { t } = useLingui();
	if (!current || !isLocked) return null;
	if (current.vaultId && current.vaultId !== activeId) return null;
	return (
		<div className="mt-3 flex items-center justify-center gap-2 text-sm">
			<span className="text-muted-foreground">{requestLine(current)}</span>
			<Button variant="secondary" size="sm" onClick={() => void answer(false)}>
				{t`Cancel`}
			</Button>
		</div>
	);
}
