import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { Mail, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { usePrefs } from "../../../../hooks/usePrefs";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import {
	type MailboxStatusRecord,
	type MembersResponse,
	mailboxStatusKey,
	parseMailboxServer,
} from "../../../../sync/mailbox";
import { formatAgo } from "../../../../util/format-date";
import { AdvancedDisclosure } from "../../../components/ui/advanced-disclosure";
import { Button } from "../../../components/ui/button";
import { InlineConfirm } from "../../../components/ui/inline-confirm";
import { TextField } from "../../../components/ui/text-field";
import { Toggle } from "../../../components/ui/toggle";
import { useMailboxStatus } from "../../../hooks/useMailboxStatus";
import { HostedAccount, HostedSignIn } from "./MailboxAccount";
import { Row, Section } from "./primitives";

type Member = MembersResponse["members"][number];
const DAY_MS = 86_400_000;

/** Each mailbox member by roster key, refreshed after every round; null while none runs. */
export function useMailboxCheckIns(): Map<string, Member> | null {
	const { shell, storage } = usePlatform();
	const { activeId } = useVaultRegistry();
	const [members, setMembers] = useState<Member[] | null>(null);
	useEffect(() => {
		if (!shell.mailboxMembers || !activeId) return;
		let live = true;
		const read = () =>
			void shell
				.mailboxMembers?.()
				.then((m) => live && setMembers(m))
				.catch(() => {});
		read();
		const off = storage.subscribeMeta?.(mailboxStatusKey(activeId), read);
		return () => {
			live = false;
			off?.();
		};
	}, [shell, storage, activeId]);
	return useMemo(() => (members ? new Map(members.map((m) => [m.sigKey, m])) : null), [members]);
}

/** A device row's mailbox line. The server keeps only the day, so that is all it can say. */
export function MailboxCheckIn({ member }: { member: Member | undefined }) {
	if (!member) return null;
	if (member.status !== "active" || member.lastCheckedDay === null) {
		return (
			<div className="text-xs text-muted-foreground">
				<Trans>Not using the mailbox</Trans>
			</div>
		);
	}
	const today = Math.floor(Date.now() / DAY_MS);
	const date = new Date(member.lastCheckedDay * DAY_MS).toLocaleDateString(i18n.locale || "en", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
	return (
		<div className="text-xs text-muted-foreground">
			{member.lastCheckedDay >= today ? (
				<Trans>Mailbox check-in: today</Trans>
			) : (
				<Trans>Mailbox check-in: {date}</Trans>
			)}
		</div>
	);
}

/**
 * The mailbox card on the Sync tab (docs/mailbox-service.md): sync between
 * devices that are never online together. Bramble's mailbox is the default; a server of one's
 * own sits under Advanced, which starts open while the hosted service is off. Before this vault
 * syncs with another device there's no group to make a mailbox for, so it shows disabled.
 */
export function MailboxSection({ connected }: { connected: boolean }) {
	const { t } = useLingui();
	const { shell } = usePlatform();
	const { prefs, update } = usePrefs();
	const { activeId } = useVaultRegistry();
	const enabled = useCan("mailboxSync");
	const hosted = useCan("mailboxHosted");
	const status = useMailboxStatus(activeId);
	const config = prefs.mailbox;
	const [advancedOpen, setAdvancedOpen] = useState(!hosted && !config);
	const [url, setUrl] = useState(config?.kind === "custom" ? config.url : "");
	const [token, setToken] = useState("");
	const [error, setError] = useState<"url" | "token" | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [confirmStop, setConfirmStop] = useState(false);

	if (!enabled || !shell.mailboxSyncNow) return null;

	const save = () => {
		const parsed = parseMailboxServer({ url, token });
		if (!parsed.ok) {
			setError(parsed.field);
			return;
		}
		setError(null);
		setAdvancedOpen(false);
		void update("mailbox", parsed.config);
	};

	const syncNow = async () => {
		setSyncing(true);
		try {
			await shell.mailboxSyncNow?.();
		} catch {
			// The status line reports what happened.
		} finally {
			setSyncing(false);
		}
	};

	const statusLine = (record: MailboxStatusRecord) => {
		switch (record.status) {
			case "synced":
				return <Trans>Synced through the mailbox {formatAgo(record.at)}</Trans>;
			case "waiting":
				return <Trans>Waiting for another device to add this one</Trans>;
			case "retry":
				return <Trans>Can't reach the mailbox; trying again soon</Trans>;
			case "collect_only":
				return <Trans>The mailbox only delivers right now</Trans>;
			case "quota_exceeded":
				return <Trans>The mailbox is full</Trans>;
			case "account_required":
				return <Trans>Add an account number to start the mailbox</Trans>;
			case "account_unknown":
				return <Trans>The mailbox doesn't recognize this account number</Trans>;
			case "other_vault":
				return (
					<Trans>
						This device uses the mailbox for another vault. Turn it off there to use it here.
					</Trans>
				);
			case "off":
				return <Trans>Off on this device</Trans>;
		}
	};

	const notConnected = <Trans>Connect a device to enable the mailbox.</Trans>;

	const advanced = (
		<AdvancedDisclosure open={advancedOpen} onOpenChange={setAdvancedOpen} className="space-y-3">
			<TextField
				label={t`Mailbox server`}
				value={url}
				onChange={(e) => setUrl(e.target.value)}
				disabled={!connected}
				error={
					error === "url" ? (
						<Trans>Enter just the server's address, like https://mailbox.example.com</Trans>
					) : undefined
				}
			/>
			<TextField
				label={t`Access token (only for your own server)`}
				type="password"
				value={token}
				onChange={(e) => setToken(e.target.value)}
				disabled={!connected}
				error={
					error === "token" ? (
						<Trans>A token is at least 16 letters, digits, dashes or underscores</Trans>
					) : undefined
				}
			/>
			<Button size="sm" onClick={save} disabled={!connected}>
				<Trans>Use this server</Trans>
			</Button>
		</AdvancedDisclosure>
	);

	return (
		<Section icon={<Mail className="w-4 h-4 text-primary" />} title={t`Mailbox`}>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Sync even when your devices are never online at the same time. The server only holds
					encrypted changes, and deletes them once every device has them.
				</Trans>
			</p>
			{config && connected && (
				<>
					<div className="text-xs text-muted-foreground font-mono">
						{config.kind === "custom" ? config.url : t`Bramble Mailbox`}
					</div>
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm">{status ? statusLine(status) : null}</span>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => void syncNow()}
							disabled={syncing}
							className="gap-1.5"
						>
							<RefreshCw className="w-3.5 h-3.5" /> <Trans>Sync now</Trans>
						</Button>
					</div>
					{config.kind === "hosted" && <HostedAccount record={status?.account} />}
					<Row
						icon={<Mail className="w-4 h-4 text-primary" />}
						title={t`Use the mailbox on this device`}
						subtitle={t`Your other devices keep using it. Off here, this device syncs only when it's online with them.`}
					>
						<Toggle
							checked={!prefs.mailboxOff}
							onChange={(on) => void update("mailboxOff", !on)}
							label={t`Use the mailbox on this device`}
						/>
					</Row>
					<InlineConfirm
						variant="destructiveOutline"
						armed={confirmStop}
						onArmedChange={setConfirmStop}
						prompt={<Trans>Every device stops syncing through it.</Trans>}
						confirmLabel={<Trans>Stop</Trans>}
						onConfirm={() => update("mailbox", null)}
						trigger={(arm) => (
							<Button variant="secondary" size="sm" onClick={arm} className="text-muted-foreground">
								<Trans>Stop using the mailbox</Trans>
							</Button>
						)}
					/>
				</>
			)}
			{hosted && (!config || !connected) && (
				<HostedSignIn disabledReason={connected ? undefined : notConnected} />
			)}
			{!hosted && !connected && <p className="text-xs text-muted-foreground">{notConnected}</p>}
			{advanced}
		</Section>
	);
}
