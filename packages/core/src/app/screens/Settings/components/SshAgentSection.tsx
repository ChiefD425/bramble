import { useLingui } from "@lingui/react/macro";
import { Check, Copy, ShieldQuestion, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import type { SshAgentStatus, SshKeyProblem } from "../../../../adapters/ssh-agent";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVaultActions } from "../../../../hooks/useVault";
import { Button } from "../../../components/ui/button";
import { Toggle } from "../../../components/ui/toggle";
import { Row, Section } from "./primitives";

/** A line to paste somewhere, with its copy button. */
function CopyLine({ line, label }: { line: string; label: string }) {
	const { clipboard } = usePlatform();
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		await (clipboard.copyPlain ?? clipboard.copy)(line);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div className="flex items-center gap-2">
			<code className="flex-1 min-w-0 truncate rounded-md border border-border/50 px-3 py-2 text-xs font-mono">
				{line}
			</code>
			<Button
				variant="ghost"
				size="none"
				onClick={() => void copy()}
				className="p-2 rounded-md"
				aria-label={label}
			>
				{copied ? <Check className="w-3.5 h-3.5 text-primary" /> : <Copy className="w-3.5 h-3.5" />}
			</Button>
		</div>
	);
}

/** The desktop's SSH agent: the switch, the line for ~/.ssh/config, the line for a shell profile,
 * the option, and the keys it can't use. Renders itself away where the platform has no agent.
 * See docs/ssh-agent.md. */
export function SshAgentSection() {
	const { sshAgent } = usePlatform();
	const { refreshAutofillIndex } = useVaultActions();
	const { t } = useLingui();
	const [status, setStatus] = useState<SshAgentStatus | null>(null);
	const [failed, setFailed] = useState<string | null>(null);

	useEffect(() => {
		if (!sshAgent) return;
		let live = true;
		void sshAgent.status().then((s) => {
			if (live) setStatus(s);
		});
		return () => {
			live = false;
		};
	}, [sshAgent]);

	if (!sshAgent || !status) return null;

	const set = async (patch: Parameters<typeof sshAgent.set>[0]) => {
		setFailed(null);
		try {
			setStatus(await sshAgent.set(patch));
			// Switched on while unlocked: the open vault's keys go to the agent now, not on the next
			// save, and the keys it can't use show straight away.
			if (patch.enabled) {
				await refreshAutofillIndex();
				setStatus(await sshAgent.status());
			}
		} catch {
			setFailed(t`The setting didn't change. Try again.`);
		}
	};

	const addLine = async () => {
		setFailed(null);
		try {
			setStatus(await sshAgent.addIncludeLine());
		} catch {
			setFailed(t`Bramble couldn't change ~/.ssh/config. Add the line yourself.`);
		}
	};

	const problem: Record<SshKeyProblem, string> = {
		"encrypted-pem": t`it's in an old encrypted format`,
		"security-key": t`its private key is on a security key`,
		dsa: t`DSA keys aren't supported`,
		"wrong-passphrase": t`the saved passphrase doesn't open it`,
		unsupported: t`Bramble doesn't support its size or settings`,
		unreadable: t`Bramble can't read it`,
	};
	const setupTitle = {
		"not-added": t`Add this line to the top of ~/.ssh/config`,
		"not-first": t`Move this line to the top of ~/.ssh/config`,
		"set-up": t`Added to ~/.ssh/config`,
	}[status.setup];

	return (
		<Section icon={<TerminalSquare className="w-4 h-4" />} title={t`SSH agent`}>
			<Row
				icon={<TerminalSquare className="w-4 h-4 text-primary" />}
				title={t`Use your SSH keys in the terminal`}
				subtitle={t`ssh and git sign with the keys in your vaults. Their public keys, names and hosts are stored outside your vaults while this is on.`}
			>
				<Toggle
					checked={status.enabled}
					onChange={(on) => void set({ enabled: on })}
					label={t`Toggle SSH agent`}
				/>
			</Row>

			{status.enabled && (
				<>
					<div className="space-y-2">
						<p className="text-sm">{setupTitle}</p>
						<CopyLine line={status.includeLine} label={t`Copy SSH config line`} />
						{status.canAddLine && status.setup !== "set-up" && (
							<Button variant="secondary" size="sm" onClick={() => void addLine()}>
								{t`Add it for me`}
							</Button>
						)}
					</div>

					{status.shellLine && (
						<div className="space-y-2">
							<p className="text-sm">{t`Use Bramble for every server`}</p>
							<p className="text-xs text-muted-foreground">
								{t`Servers not named on a key, and git commit signing, use your usual SSH agent. To use Bramble for them too, add this line to your shell profile, such as ~/.zshrc.`}
							</p>
							<CopyLine line={status.shellLine} label={t`Copy shell line`} />
						</div>
					)}

					{status.error && (
						<p className="text-xs text-destructive">
							{
								{
									"path-too-long": t`Your home folder's path is too long for the agent's socket.`,
									"bind-failed": t`The SSH agent couldn't start. Restart Bramble to try again.`,
									"config-failed": t`Bramble couldn't write its files in ~/.ssh/bramble.`,
								}[status.error]
							}
						</p>
					)}
					{failed && <p className="text-xs text-destructive">{failed}</p>}

					<Row
						icon={<ShieldQuestion className="w-4 h-4 text-primary" />}
						title={t`Ask before each use`}
						subtitle={t`Bramble asks every time a key is used, even while unlocked.`}
					>
						<Toggle
							checked={status.askEachUse}
							onChange={(on) => void set({ askEachUse: on })}
							label={t`Ask before each use`}
						/>
					</Row>

					{(status.unusable.length > 0 || status.leftOut.length > 0) && (
						<div className="space-y-1 text-xs text-muted-foreground">
							{status.unusable.map((k) => (
								<p key={k.entryId}>{t`Can't use ${k.name}: ${problem[k.reason]}`}</p>
							))}
							{status.leftOut.map((l) => (
								<p key={`${l.entryId}-${l.host}`}>
									{t`Left out ${l.host} on ${l.name}: not a host name`}
								</p>
							))}
							{status.unusable.length > 0 && (
								<p>{t`Re-save a key in OpenSSH format with ssh-keygen -p -f <file>.`}</p>
							)}
						</div>
					)}
				</>
			)}
		</Section>
	);
}
