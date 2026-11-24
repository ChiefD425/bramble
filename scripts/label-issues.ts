// node scripts/label-issues.ts   (run by .github/workflows/label-issues.yml)
//
// Labels an issue from the answers on its form (.github/ISSUE_TEMPLATE), so labels follow from what
// the reporter picked rather than from anyone's reading of the text. The forms add `bug` or
// `enhancement` themselves; this adds the apps and areas picked, and `needs info` while a bug report
// is missing a version number, or the device list a sync or desktop link problem needs.
//
// On an edit it compares the old body with the new: labels only the old answers gave come off, and
// labels only the new answers give go on. A label added or removed by hand stays as it was, unless
// the reporter changes the answer it came from.
//
// The issue body is untrusted input. It is read from the event file and only ever matched against
// the fixed lists below; it never reaches a shell. Issue forms render each answer under its field's
// label as a "### " heading, a multiple choice dropdown as its options joined by ", ", and an empty
// answer as "_No response_". The dropdowns come first on both forms, so text typed into a later
// field cannot pose as one of their headings.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL (optional).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AREA = "c5def5";

/** Every label this can add, so it can create one the repository does not have yet. */
export const LABELS = {
	chromium: { color: "4d5b85", description: "Applies to the Chromium extension" },
	firefox: { color: "d93f0b", description: "Applies to the Firefox extension" },
	extension: {
		color: "7c5adf",
		description: "Applies to both extension targets (Chromium and Firefox)",
	},
	desktop: { color: "0e8a16", description: "Applies to the desktop app" },
	macOS: { color: "5a5a5a", description: "Applies to the desktop app on macOS" },
	windows: { color: "0078d4", description: "Applies to the desktop app on Windows" },
	linux: { color: "f9c513", description: "Applies to the desktop app on Linux" },
	iOS: { color: "153c2f", description: "Applies to the iOS app" },
	android: { color: "1dafac", description: "Applies to the Android app" },
	mobile: { color: "ce9452", description: "Applies to both mobile targets (Android and iOS)" },
	website: { color: "1d76db", description: "Applies to bramble.sh or its help center" },
	autofill: { color: AREA, description: "Filling into sites and apps" },
	passkeys: { color: AREA, description: "Saving and signing in with passkeys" },
	sync: { color: AREA, description: "Sync between devices" },
	"desktop link": { color: AREA, description: "The browser extension's link to the desktop app" },
	unlock: { color: AREA, description: "Unlocking, biometrics, security keys and auto-lock" },
	"import/export": { color: AREA, description: "Importing from other apps and exporting" },
	backups: { color: AREA, description: "Backups to files and cloud storage" },
	totp: { color: AREA, description: "Two-factor codes" },
	aliases: { color: AREA, description: "Email aliases" },
	"vault items": {
		color: AREA,
		description: "Logins, cards, notes, fields, tags and attachments",
	},
	generator: { color: AREA, description: "The password generator" },
	ui: { color: AREA, description: "Look, layout and accessibility" },
	translations: { color: AREA, description: "The apps in other languages" },
	install: { color: AREA, description: "Installing and updating Bramble" },
	"needs info": { color: "fbca04", description: "Waiting on details from the reporter" },
} satisfies Record<string, { color: string; description: string }>;

type Label = keyof typeof LABELS;

/** The apps a form offers, and the labels each adds. No option may contain ", ". */
export const APPS: Record<string, Label[]> = {
	"Browser extension in Chrome or another Chromium browser (Edge / Brave / Vivaldi / Opera / Arc)":
		["chromium"],
	"Browser extension in Firefox or a Firefox-based browser (Zen / LibreWolf / Floorp)": ["firefox"],
	"Desktop app on macOS": ["desktop", "macOS"],
	"Desktop app on Windows": ["desktop", "windows"],
	"Desktop app on Linux": ["desktop", "linux"],
	"iOS app (iPhone or iPad)": ["iOS"],
	"Android app": ["android"],
	"Website or help center (bramble.sh)": ["website"],
	"Every app": [],
};

/** The areas a form offers, and the label each adds. No option may contain ", ". */
export const AREAS: Record<string, Label[]> = {
	Autofill: ["autofill"],
	Passkeys: ["passkeys"],
	"Sync between devices": ["sync"],
	"Link between the browser extension and the desktop app": ["desktop link"],
	"Unlocking and auto-lock (password / biometrics / security keys)": ["unlock"],
	"Import or export": ["import/export"],
	Backups: ["backups"],
	"Two-factor codes (TOTP)": ["totp"],
	"Email aliases": ["aliases"],
	"Vault items (logins / cards / notes / fields / tags / attachments)": ["vault items"],
	"Password generator": ["generator"],
	"Look and layout / accessibility": ["ui"],
	Translations: ["translations"],
	"Install and updates": ["install"],
	"Something else": [],
};

/** Field labels on the forms. A field appears under its label as a "### " heading. */
export const HEADINGS = {
	apps: ["Which apps does it happen in?", "Which apps is it for?"],
	area: "What part of Bramble?",
	version: "Bramble version",
	devices: "Every device in the sync or link",
} as const;

/** The answer under the first of these headings: "" when left empty, undefined when not asked. */
function answer(body: string, headings: readonly string[]): string | undefined {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	const at = lines.findIndex((l) => l.startsWith("### ") && headings.includes(l.slice(4).trim()));
	if (at < 0) return undefined;
	const end = lines.findIndex((l, i) => i > at && l.startsWith("### "));
	const text = lines
		.slice(at + 1, end < 0 ? undefined : end)
		.join("\n")
		.trim();
	return text === "_No response_" ? "" : text;
}

function picked(text: string | undefined, options: Record<string, Label[]>): Label[] {
	if (!text) return [];
	return text
		.split(/,\s*|\n/)
		.map((s) => s.trim())
		.flatMap((s) => options[s] ?? []);
}

/** What a bug report is missing, in the order the form asks for it. Empty for a feature request. */
export function missing(body: string): ("version" | "devices")[] {
	const out: ("version" | "devices")[] = [];
	const version = answer(body, [HEADINGS.version]);
	if (version !== undefined && !/\d+\.\d+/.test(version)) out.push("version");
	const devices = answer(body, [HEADINGS.devices]);
	const areas = picked(answer(body, [HEADINGS.area]), AREAS);
	const linked = areas.includes("sync") || areas.includes("desktop link");
	if (devices !== undefined && linked && !devices) out.push("devices");
	return out;
}

/** The labels a form's answers give, in a stable order. */
export function labelsFor(body: string): Label[] {
	const found = new Set<Label>([
		...picked(answer(body, HEADINGS.apps), APPS),
		...picked(answer(body, [HEADINGS.area]), AREAS),
	]);
	// The umbrella labels mean both targets, as their descriptions say.
	if (found.has("chromium") && found.has("firefox")) found.add("extension");
	if (found.has("android") && found.has("iOS")) found.add("mobile");
	if (missing(body).length) found.add("needs info");
	return (Object.keys(LABELS) as Label[]).filter((l) => found.has(l));
}

/** Labels to add and remove when a body changes; `before` is null for a new issue. */
export function relabel(before: string | null, after: string): { add: Label[]; remove: Label[] } {
	const was = before === null ? [] : labelsFor(before);
	const now = labelsFor(after);
	return {
		add: now.filter((l) => !was.includes(l)),
		remove: was.filter((l) => !now.includes(l)),
	};
}

export const MARKER = "<!-- label-issues:needs-info -->";

const ASKS = {
	version: "**Bramble version**: the number under Settings → About, like 0.22.0.",
	devices:
		"**Every device in the sync or link**: one line per device with its app and its Bramble version. Sync and the desktop link depend on every device taking part.",
} as const;

export function needsInfoComment(body: string): string {
	return [
		MARKER,
		"Thanks for the report. To look into it we also need:",
		"",
		...missing(body).map((m) => `- ${ASKS[m]}`),
		"",
		"Edit the issue to add them and the `needs info` label comes off on its own.",
	].join("\n");
}

export type Api = (
	method: string,
	path: string,
	body?: unknown,
) => Promise<{ status: number; data: unknown }>;

export interface IssuesEvent {
	action: string;
	issue: { number: number; body: string | null };
	changes?: { body?: { from: string | null } };
}

/** Applies the labels for one issues event and returns what it changed, for the log. */
export async function labelIssue(event: IssuesEvent, repo: string, api: Api): Promise<string> {
	if (event.action !== "opened" && !(event.action === "edited" && event.changes?.body)) return "";
	const before = event.action === "opened" ? null : (event.changes?.body?.from ?? "");
	const after = event.issue.body ?? "";
	const { add, remove } = relabel(before, after);
	const issue = `/repos/${repo}/issues/${event.issue.number}`;

	for (const name of add) {
		const { status } = await api("POST", `/repos/${repo}/labels`, { name, ...LABELS[name] });
		if (status !== 201 && status !== 422) throw new Error(`creating label ${name}: ${status}`);
	}
	if (add.length) {
		const { status } = await api("POST", `${issue}/labels`, { labels: add });
		if (status !== 200) throw new Error(`adding labels: ${status}`);
	}
	for (const name of remove) {
		const { status } = await api("DELETE", `${issue}/labels/${encodeURIComponent(name)}`);
		if (status !== 200 && status !== 404) throw new Error(`removing label ${name}: ${status}`);
	}
	if (add.includes("needs info")) {
		const { status: read, data } = await api("GET", `${issue}/comments?per_page=100`);
		if (read !== 200) throw new Error(`reading comments: ${read}`);
		const asked = (data as { body?: string }[]).some((c) => c.body?.startsWith(MARKER));
		if (!asked) {
			const { status } = await api("POST", `${issue}/comments`, { body: needsInfoComment(after) });
			if (status !== 201) throw new Error(`commenting: ${status}`);
		}
	}
	return [...add.map((l) => `+${l}`), ...remove.map((l) => `-${l}`)].join(" ");
}

function githubApi(token: string): Api {
	const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
	return async (method, path, body) => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, data: text ? JSON.parse(text) : null };
	};
}

async function main(): Promise<void> {
	const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } = process.env;
	if (!GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_PATH)
		throw new Error("needs GH_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH");
	const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8")) as IssuesEvent;
	const changed = await labelIssue(event, GITHUB_REPOSITORY, githubApi(GH_TOKEN));
	console.log(`#${event.issue.number}: ${changed || "no label changes"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((e: Error) => {
		console.error(e.message);
		process.exit(1);
	});
}
