// node scripts/docs-gates.ts [--fix | --pre-push]
//
// Help-article and blog text that waits for a release (website/README.md, "Text that waits for a
// release").
//
// - No flag: where each gate stands. Still waiting, out on some targets, or out everywhere, which
//   means the gate can go: keep the Since text and delete the Until and Rollout. The deploy prints
//   this in its job summary.
// - --fix: after a rebase, point gates at the commits it rewrote. A rebase gives every unpushed
//   commit a new hash but keeps its subject and author date, which is how the new one is found.
// - --pre-push: the .githooks/pre-push check. Refuses a push whose articles name a commit the
//   pushed history doesn't contain, because the website deploy would fail on it.
//
// Exits 1 on a gate the website build would refuse.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	articleGate,
	type GateStatus,
	gateStatus,
	parseGates,
	type StatusLookup,
} from "../website/src/doc-gates.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = "website/src/content/docs";
/** Everywhere text can wait for a release: help articles, and blog posts about a change. */
const GATED = [DOCS, "website/src/content/blog"];
/** A file's name in what this prints: blog posts say so, help articles keep their bare name. */
const label = (dir: string, name: string) => (/(^|\/)blog$/.test(dir) ? `blog/${name}` : name);

type Article = { name: string; mdx: string };

export interface Unreachable {
	file: string;
	commit: string;
	/** The commit a rebase rewrote it as, when one in the history matches. */
	rewrittenAs?: string;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function standing(s: GateStatus, done: string): string {
	const shipped = s.shipped.map((r) => `${r.target} ${r.version}`).join(", ");
	const waiting = `waiting for ${s.pending.join(", ")}`;
	if (s.state === "none") return waiting;
	if (s.state === "partial") return `in ${shipped}; ${waiting}`;
	return `shipped everywhere (${shipped}): ${done}`;
}

/** One line per gated commit and target list in each article, and per article that waits. */
export function describeGates(files: Article[], status: StatusLookup): string[] {
	const lines: string[] = [];
	for (const { name, mdx } of files) {
		const seen = new Set<string>();
		for (const g of parseGates(mdx, name)) {
			const key = `${g.commit} ${g.on.join(",")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const done = "keep the Since text, delete the Until and Rollout";
			lines.push(`${name}  ${g.commit}  ${standing(status(g.commit, g.on), done)}`);
		}
		const article = articleGate(mdx);
		if (article) {
			const s = status(article.commit, article.on);
			const done = "delete since and sinceOn from the frontmatter";
			lines.push(`${name}  ${article.commit}  whole article, ${standing(s, done)}`);
		}
	}
	return lines;
}

/** The articles in `dir` that carry a gate, as of commit `tip`. */
export function filesAt(tip: string, dir: string, cwd = ROOT): Article[] {
	let found: string;
	try {
		found = git(
			cwd,
			"grep",
			"-l",
			"-E",
			"-e",
			"<(Since|Until|Rollout)[ >]",
			"-e",
			"^since:",
			tip,
			"--",
			dir,
		);
	} catch {
		return []; // git grep exits 1 when nothing matches
	}
	return found
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(tip.length + 1))
		.sort()
		.map((path) => ({ name: path.slice(dir.length + 1), mdx: git(cwd, "show", `${tip}:${path}`) }));
}

function gatedCommits({ name, mdx }: Article): string[] {
	const commits = parseGates(mdx, name).map((g) => g.commit);
	const article = articleGate(mdx);
	if (article) commits.push(article.commit);
	return [...new Set(commits)];
}

function contains(tip: string, commit: string, cwd: string): boolean {
	try {
		git(cwd, "merge-base", "--is-ancestor", commit, tip);
		return true;
	} catch {
		return false;
	}
}

/** The commit in `tip`'s history with `commit`'s subject and author date, abbreviated alike. */
function rewrittenAs(commit: string, tip: string, cwd: string): string | undefined {
	let original: string;
	try {
		original = git(cwd, "log", "-1", "--format=%at%x09%s", commit);
	} catch {
		return undefined; // not even in this clone, so nothing to match it by
	}
	const [authored] = original.split("\t");
	const candidates = git(cwd, "log", tip, `--since=@${authored}`, "--format=%H%x09%at%x09%s");
	const match = candidates
		.split("\n")
		.find((line) => line.slice(line.indexOf("\t") + 1) === original);
	return (
		match && git(cwd, "rev-parse", `--short=${commit.length}`, match.slice(0, match.indexOf("\t")))
	);
}

/** Gates naming a commit outside `tip`'s history, which the deploy of `tip` would fail on. */
export function unreachableGates(files: Article[], tip: string, cwd = ROOT): Unreachable[] {
	const out: Unreachable[] = [];
	for (const file of files) {
		for (const commit of gatedCommits(file)) {
			if (contains(tip, commit, cwd)) continue;
			const rewritten = rewrittenAs(commit, tip, cwd);
			out.push({ file: file.name, commit, ...(rewritten ? { rewrittenAs: rewritten } : {}) });
		}
	}
	return out;
}

/** The working tree's articles in `dir`, as `label` names them. */
function filesIn(dir: string, cwd: string): Article[] {
	return readdirSync(join(cwd, dir))
		.filter((f) => /\.mdx?$/.test(f))
		.sort()
		.map((name) => ({ name: label(dir, name), mdx: readFileSync(join(cwd, dir, name), "utf8") }));
}

/** Point the working tree's gates at the commits a rebase rewrote theirs as. */
export function fixGates(
	dirs: string | string[] = GATED,
	cwd = ROOT,
): { fixed: Unreachable[]; left: Unreachable[] } {
	const found: Unreachable[] = [];
	for (const dir of [dirs].flat()) {
		const inDir = unreachableGates(filesIn(dir, cwd), "HEAD", cwd);
		for (const { file, commit, rewrittenAs: next } of inDir) {
			if (!next) continue;
			const path = join(cwd, dir, file.slice(file.lastIndexOf("/") + 1));
			const text = readFileSync(path, "utf8")
				.replaceAll(`commit="${commit}"`, `commit="${next}"`)
				.replace(new RegExp(`^(since:\\s*["']?)${commit}(["']?\\s*)$`, "m"), `$1${next}$2`);
			writeFileSync(path, text);
		}
		found.push(...inDir);
	}
	return { fixed: found.filter((g) => g.rewrittenAs), left: found.filter((g) => !g.rewrittenAs) };
}

function describeUnreachable({ file, commit, rewrittenAs: next }: Unreachable): string {
	return next
		? `  ${file}  ${commit} is now ${next} (a rebase rewrote it)`
		: `  ${file}  ${commit} isn't in this history`;
}

/**
 * The pre-push check, over git's protocol on stdin: one `<local ref> <local sha> <remote ref>
 * <remote sha>` line per ref. Returns the exit code: 1 to refuse the push.
 */
export function prePush(stdin: string, dirs: string | string[] = GATED, cwd = ROOT): number {
	const blocked: Unreachable[] = [];
	for (const line of stdin.split("\n").filter(Boolean)) {
		const [localRef = "", localSha = ""] = line.split(" ");
		if (!localRef.startsWith("refs/heads/") || /^0+$/.test(localSha)) continue;
		for (const dir of [dirs].flat()) {
			const files = filesAt(localSha, dir, cwd).map((f) => ({ ...f, name: label(dir, f.name) }));
			blocked.push(...unreachableGates(files, localSha, cwd));
		}
	}
	if (blocked.length === 0) return 0;
	console.error(
		[
			"Push blocked: help articles wait for commits this push doesn't contain, so the website deploy would fail.",
			...blocked.map(describeUnreachable),
			"Run `pnpm docs:gates --fix`, commit, and push again.",
		].join("\n"),
	);
	return 1;
}

function main(): number {
	if (process.argv.includes("--pre-push")) return prePush(readFileSync(0, "utf8"));
	if (process.argv.includes("--fix")) {
		const { fixed, left } = fixGates();
		for (const g of fixed) console.log(`${g.file}  ${g.commit} -> ${g.rewrittenAs}`);
		for (const g of left) console.error(describeUnreachable(g).trim());
		if (!fixed.length && !left.length) console.log("Every gate names a commit in this history.");
		return left.length ? 1 : 0;
	}
	const files = GATED.flatMap((dir) => filesIn(dir, ROOT));
	const lines = describeGates(files, gateStatus);
	console.log(lines.length ? lines.join("\n") : "No help article waits for a release.");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exit(main());
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
