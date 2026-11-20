// Help-article text that waits for a release. An article names the commit a change landed in;
// the text switches once a release containing that commit is tagged, on the targets it names.
// Release tags (`1.41.0-chromium`, `0.20.0-desktop`, `1.27.0-build217304470-ios`) are the only
// record this reads: no list to keep by hand. See website/README.md, "Text that waits for a
// release".
//
// Pure apart from `releaseTagsContaining`, so the build, the search index and
// scripts/docs-gates.ts all decide the same way.

import { execFileSync } from "node:child_process";

export const TARGETS = ["chromium", "firefox", "desktop", "android", "ios"] as const;
export type Target = (typeof TARGETS)[number];

const TARGET_NAMES: Record<Target, string> = {
	chromium: "Chrome extension",
	firefox: "Firefox extension",
	desktop: "desktop app",
	android: "Android app",
	ios: "iPhone app",
};

export type GateKind = "Since" | "Until" | "Rollout";
export type GateState = "none" | "partial" | "all";

export interface TaggedRelease {
	tag: string;
	date: Date;
}

export interface Release {
	target: Target;
	version: string;
	date: Date;
}

export interface GateStatus {
	commit: string;
	on: Target[];
	state: GateState;
	/** The first release of each target that contains the commit, in TARGETS order. */
	shipped: Release[];
	pending: Target[];
}

export interface Gate {
	kind: GateKind;
	commit: string;
	on: Target[];
	inner: string;
	start: number;
	end: number;
}

export type StatusLookup = (commit: string, on: readonly Target[]) => GateStatus;

/** A release tag's target and version, or null for any other tag. */
export function parseReleaseTag(tag: string): { target: Target; version: string } | null {
	const m = /^(\d+\.\d+\.\d+)-(?:build\d+-(ios)|(chromium|firefox|desktop|android))$/.exec(tag);
	if (!m?.[1]) return null;
	return { version: m[1], target: (m[2] ?? m[3]) as Target };
}

/** The `on` attribute: `all` (the default), or targets separated by commas or spaces. */
export function parseOn(on?: string): Target[] {
	if (on === undefined || on.trim() === "all") return [...TARGETS];
	const names = on.split(/[\s,]+/).filter(Boolean);
	if (names.length === 0) throw new Error(`on="${on}" names no target`);
	for (const name of names) {
		if (!(TARGETS as readonly string[]).includes(name)) {
			throw new Error(`on="${on}": "${name}" isn't a target (${TARGETS.join(", ")}, or all)`);
		}
	}
	return names as Target[];
}

export function statusFrom(
	commit: string,
	on: readonly Target[],
	tags: readonly TaggedRelease[],
): GateStatus {
	const first = new Map<Target, Release>();
	for (const { tag, date } of tags) {
		const release = parseReleaseTag(tag);
		if (!release || !on.includes(release.target)) continue;
		const known = first.get(release.target);
		if (!known || date < known.date) first.set(release.target, { ...release, date });
	}
	const shipped = TARGETS.flatMap((t) => first.get(t) ?? []);
	const pending = on.filter((t) => !first.has(t));
	const state = shipped.length === 0 ? "none" : pending.length === 0 ? "all" : "partial";
	return { commit, on: [...on], state, shipped, pending };
}

/** Since: once on every target. Until: until then. Rollout: while some have it and some don't. */
export function shows(kind: GateKind, state: GateState): boolean {
	if (kind === "Since") return state === "all";
	if (kind === "Until") return state !== "all";
	return state === "partial";
}

const GATE = /<(Since|Until|Rollout)\b([^>]*?)>([\s\S]*?)<\/\1>/g;
const OPENING = /<(Since|Until|Rollout)\b/g;
const NESTED = /<(Since|Until|Rollout)\b/;
const ATTRIBUTE = /(\w+)="([^"]*)"/g;

/** Every gate in an article's MDX source. Throws on one the build would get wrong. */
export function parseGates(mdx: string, file?: string): Gate[] {
	const fail = (message: string): never => {
		throw new Error(file ? `${file}: ${message}` : message);
	};
	const gates: Gate[] = [];
	for (const m of mdx.matchAll(GATE)) {
		const [whole, kind, attributes = "", inner = ""] = m;
		const label = `<${kind}> at character ${m.index}`;
		const attrs = new Map<string, string>();
		for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) {
			if (name !== "commit" && name !== "on") fail(`${label} has an unknown attribute "${name}"`);
			attrs.set(name as string, value as string);
		}
		const commit = attrs.get("commit") ?? "";
		if (!/^[0-9a-f]{7,40}$/.test(commit)) fail(`${label} needs commit="<sha>"`);
		if (NESTED.test(inner)) fail(`${label} has another gate inside it`);
		// The table of contents is built from the rendered headings, which a gate can't hide.
		if (/^\s*#{1,6}\s/m.test(inner)) fail(`${label} has a heading inside it`);
		let on: Target[] = [];
		try {
			on = parseOn(attrs.get("on"));
		} catch (e) {
			fail(`${label}: ${(e as Error).message}`);
		}
		gates.push({
			kind: kind as GateKind,
			commit,
			on,
			inner,
			start: m.index,
			end: m.index + whole.length,
		});
	}
	const opened = [...mdx.matchAll(OPENING)].length;
	if (opened !== gates.length) fail(`a <Since>, <Until> or <Rollout> isn't closed`);
	return gates;
}

/** The article's source with each gate replaced by what a reader sees: its text, or nothing. */
export function resolveGates(mdx: string, status: StatusLookup, file?: string): string {
	let out = "";
	let from = 0;
	for (const g of parseGates(mdx, file)) {
		out += mdx.slice(from, g.start);
		if (shows(g.kind, status(g.commit, g.on).state)) out += g.inner;
		from = g.end;
	}
	return out + mdx.slice(from);
}

function list(items: string[]): string {
	return items.length < 2
		? (items[0] ?? "")
		: `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What follows a Rollout's text while only some targets have the change. */
export function rolloutNote(status: GateStatus): string {
	const where = list(status.shipped.map((r) => `${TARGET_NAMES[r.target]} ${r.version}`));
	const next = list(status.pending.map((t) => TARGET_NAMES[t]));
	const one = status.pending.length === 1;
	return `in the ${where} and later. The ${next} ${one ? "gets it in its" : "get it in their"} next update.`;
}

/**
 * When a release last changed what a reader sees in this article: a Since or Until that has
 * flipped, or a Rollout that is showing. Undefined while every gate still reads as written.
 */
export function changedOn(mdx: string, status: StatusLookup, file?: string): Date | undefined {
	let latest: Date | undefined;
	for (const g of parseGates(mdx, file)) {
		const s = status(g.commit, g.on);
		const changed = g.kind === "Rollout" ? s.state === "partial" : s.state === "all";
		if (!changed) continue;
		for (const { date } of s.shipped) if (!latest || date > latest) latest = date;
	}
	return latest;
}

/**
 * The release a whole article waits for, from its raw file's frontmatter (`since`, `sinceOn`).
 * The build reads the same two fields through the content schema; this is for scripts that see
 * the file as text.
 */
export function articleGate(raw: string): { commit: string; on: Target[] } | undefined {
	const frontmatter = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "";
	const field = (name: string) =>
		new RegExp(`^${name}:\\s*["']?([^"'\\n]*?)["']?\\s*$`, "m").exec(frontmatter)?.[1];
	const commit = field("since");
	return commit ? { commit, on: parseOn(field("sinceOn")) } : undefined;
}

/** Release tags whose commit contains `commit`, from this clone's git history. */
export function releaseTagsContaining(commit: string, cwd?: string): TaggedRelease[] {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	if (git("rev-parse", "--is-shallow-repository") === "true") {
		throw new Error(
			"this clone is shallow, so it can't tell which releases contain a commit: fetch the full history and tags (actions/checkout fetch-depth: 0)",
		);
	}
	try {
		git("rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
	} catch {
		throw new Error(
			`commit ${commit} isn't in this repository's history (if it was rebased, gate on its new hash)`,
		);
	}
	const out = git(
		"tag",
		"--contains",
		commit,
		"--format=%(refname:short)\t%(creatordate:iso-strict)",
	);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [tag = "", date = ""] = line.split("\t");
			return { tag, date: new Date(date) };
		});
}

const tagsByCommit = new Map<string, TaggedRelease[]>();

/** Where `commit` stands on the targets in `on`, from this clone's release tags. */
export function gateStatus(commit: string, on: string | readonly Target[] | undefined): GateStatus {
	const targets = typeof on === "string" || on === undefined ? parseOn(on) : on;
	let tags = tagsByCommit.get(commit);
	if (!tags) {
		tags = releaseTagsContaining(commit);
		tagsByCommit.set(commit, tags);
	}
	return statusFrom(commit, targets, tags);
}
