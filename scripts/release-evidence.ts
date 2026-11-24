// What a GitHub release page says about how it was checked (docs/ci-releases.md, "What a release
// page shows"): the CI run that passed on the commit it was built from, and every commit since the
// last release that changed security-sensitive code (scripts/release-paths.ts). Both are generated
// on the runner and added below the notes, so neither can be edited out before the page publishes.
//
//   node scripts/release-evidence.ts wait-for-ci [sha]                 the release workflows' Tested job
//   node scripts/release-evidence.ts security <from> <to> <target>     the list, for any range

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { securityFiles } from "./release-paths.ts";

/** The CI run that passed on a commit: what the Tested job hands the publish job. */
export type Tested = {
	sha: string;
	url: string;
	number: number;
	attempt: number;
	jobs: { name: string; conclusion: string | null }[];
};

type Run = {
	id: number;
	run_number: number;
	run_attempt: number;
	head_sha: string;
	event: string;
	status: string;
	conclusion: string | null;
	html_url: string;
};

export type CiDeps = {
	api: (path: string) => Promise<unknown>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	log: (line: string) => void;
};

/**
 * Wait for ci.yml to finish on `sha`, and return the run if it passed. Throws if it failed, if it
 * is still running at `timeoutMs`, or if no run for `sha` has appeared after `noRunMs`.
 */
export async function waitForCi(
	repo: string,
	sha: string,
	deps: CiDeps,
	{ timeoutMs = 60 * 60_000, noRunMs = 5 * 60_000, pollMs = 30_000 } = {},
): Promise<Tested> {
	const start = deps.now();
	let said = "";
	for (;;) {
		const { workflow_runs: runs } = (await deps.api(
			`/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`,
		)) as { workflow_runs: Run[] };
		const run = runs
			.filter((r) => r.head_sha === sha && (r.event === "push" || r.event === "workflow_dispatch"))
			.sort((a, b) => b.run_number - a.run_number)[0];
		const waited = deps.now() - start;

		if (!run) {
			if (waited >= noRunMs)
				throw new Error(
					`CI never ran on ${sha.slice(0, 8)}. Run it on main from the Actions tab ` +
						"(gh workflow run ci.yml --ref main) and dispatch the release again once it passes.",
				);
		} else if (run.status === "completed") {
			if (run.conclusion !== "success")
				throw new Error(
					`CI ended ${run.conclusion} on ${sha.slice(0, 8)}: ${run.html_url}\n` +
						"Nothing was built. Fix it or re-run the failed jobs there, then dispatch the release again.",
				);
			const { jobs } = (await deps.api(
				`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
			)) as { jobs: { name: string; conclusion: string | null }[] };
			return {
				sha,
				url: run.html_url,
				number: run.run_number,
				attempt: run.run_attempt,
				jobs: jobs.map(({ name, conclusion }) => ({ name, conclusion })),
			};
		} else {
			const now = `CI is ${run.status.replace("_", " ")} on ${sha.slice(0, 8)}: ${run.html_url}`;
			if (now !== said) deps.log(`${now}\nwaiting for it to finish`);
			said = now;
		}
		if (waited >= timeoutMs)
			throw new Error(`CI was still running on ${sha.slice(0, 8)} after ${timeoutMs / 60_000} min`);
		await deps.sleep(pollMs);
	}
}

/** A commit since the last release that changed security-sensitive files this target ships. */
export type SecurityCommit = { sha: string; subject: string; files: string[] };

/** Parse `git log --format=%x00%H%x09%s --name-only`, keeping the commits that matter to `target`. */
export function securityCommits(log: string, target: string): SecurityCommit[] {
	const out: SecurityCommit[] = [];
	for (const chunk of log.split("\0").slice(1)) {
		const [head = "", ...rest] = chunk.split("\n");
		const [sha = "", subject = ""] = head.split("\t");
		// Version bumps: the manifests they touch are on the list for what other commits do to them.
		if (/^chore\(release\)/.test(subject)) continue;
		const files = securityFiles(rest.filter(Boolean), target);
		if (files.length) out.push({ sha, subject, files });
	}
	return out;
}

export function gitSecurityCommits(from: string, to: string, target: string): SecurityCommit[] {
	const log = execFileSync(
		"git",
		["log", "--no-merges", "--format=%x00%H%x09%s", "--name-only", `${from}..${to}`],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	return securityCommits(log, target);
}

/**
 * How to rebuild each target and compare it with what was published, and what the daily check
 * covers (docs/reproducible-builds.md). `daily` is the Verify releases workflow's link.
 */
const REBUILD: Record<string, (tag: string, daily: string) => string> = {
	chromium: (tag, daily) =>
		`\`node scripts/verify-release.ts ${tag}\` rebuilds it from source and compares it with this page's files and the Chrome Web Store's copy. ${daily} does the same every day for the version the store serves.`,
	firefox: (tag, daily) =>
		`\`node scripts/verify-release.ts ${tag}\` rebuilds it from source and compares it with this page's files and the copy on addons.mozilla.org. ${daily} does the same every day for the version addons.mozilla.org serves.`,
	android: (tag, daily) =>
		`\`node scripts/verify-release.ts ${tag}\` rebuilds the APK from source and compares every file in it with this page's, apart from the signature. ${daily} does the same every day for the newest release.`,
	desktop: (tag, daily) =>
		`\`node scripts/verify-release.ts ${tag} --arch amd64\` (or \`arm64\`) rebuilds the Linux packages from source and compares them with this page's, and ${daily} does that every day for the newest release. \`--macos\` checks the macOS app, on a Mac with the release's Xcode.`,
};

export type PageInput = {
	repo: string;
	target: string;
	tag: string;
	/** The previous release of this target, or "" for its first. */
	prev: string;
	/** What was built, so the files linked are the ones this release saw. */
	head: string;
	commits: SecurityCommit[];
	/** Null when cut on the maintainer's machine (--local), where no CI run is attached. */
	tested: Tested | null;
	/** This release's workflow run. */
	runUrl: string | null;
};

const short = (sha: string) => sha.slice(0, 8);

/** The two sections every GitHub release page ends with. */
export function evidenceSections(p: PageInput): string {
	const gh = `https://github.com/${p.repo}`;
	const commit = (sha: string) => `[${short(sha)}](${gh}/commit/${sha})`;
	const doc = (path: string) => `[${path}](${gh}/blob/${p.head}/${path})`;
	const list = doc("scripts/release-paths.ts");

	let security: string;
	if (!p.prev) security = `This is the first ${p.target} release, so there is nothing to compare.`;
	else if (!p.commits.length)
		security = `None. No commit since ${p.prev} changes a file this app ships that is on the security-sensitive list in ${list}.`;
	else
		security =
			`${p.commits.length === 1 ? "This commit" : `These ${p.commits.length} commits`} since ${p.prev} change files this app ships that are on the security-sensitive list in ${list}:\n\n` +
			p.commits.map((c) => `- ${commit(c.sha)} ${c.subject}`).join("\n");
	if (p.prev)
		security += `\n\nTo list them yourself: \`node scripts/release-evidence.ts security ${p.prev} ${p.tag} ${p.target}\``;

	const checked: string[] = [];
	if (p.tested) {
		const named = (c: string) =>
			p.tested?.jobs
				.filter((j) => j.conclusion === c)
				.map((j) => j.name)
				.sort() ?? [];
		const passed = named("success");
		const skipped = named("skipped");
		checked.push(
			`**Tests.** [CI run ${p.tested.number}](${p.tested.url}) passed on ${commit(p.tested.sha)}` +
				(p.tested.attempt > 1 ? `, on attempt ${p.tested.attempt}` : "") +
				`, and this release is that commit with its version number raised. Passed: ${passed.join(", ")}.` +
				(skipped.length ? ` Skipped: ${skipped.join(", ")}.` : "") +
				` What each job runs: ${doc(".github/workflows/ci.yml")}.`,
		);
	} else {
		checked.push(
			"**Tests.** Built on the maintainer's machine, which runs lint, type checks and the unit tests first. No CI run is attached.",
		);
	}
	if (p.runUrl)
		checked.push(`**Build.** [This release run](${p.runUrl}) built, signed and published it.`);
	const rebuild = REBUILD[p.target];
	if (rebuild)
		checked.push(
			`**Reproducible.** ${rebuild(p.tag, `[Verify releases](${gh}/actions/workflows/verify-releases.yml)`)} How: ${doc("docs/reproducible-builds.md")}.`,
		);
	if (p.target === "desktop")
		checked.push(
			`**Logged.** The desktop app installs this update only with proof that it is in the public Sigsum log. ${doc("docs/update-transparency.md")}`,
		);

	return [
		"## Security-relevant changes",
		security,
		"## How this release was checked",
		checked.map((c) => `- ${c}`).join("\n"),
	].join("\n\n");
}

async function githubApi(path: string): Promise<unknown> {
	const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	const res = await fetch(`${base}${path}`, {
		headers: {
			accept: "application/vnd.github+json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status} ${await res.text()}`);
	return res.json();
}

async function main(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	if (command === "wait-for-ci") {
		const repo = process.env.GITHUB_REPOSITORY ?? "bramble-sh/bramble";
		const sha = rest[0] ?? process.env.GITHUB_SHA;
		if (!sha) throw new Error("wait-for-ci needs a commit");
		const tested = await waitForCi(repo, sha, {
			api: githubApi,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			now: Date.now,
			log: console.log,
		});
		console.log(`CI passed on ${short(sha)}: ${tested.url}`);
		if (process.env.GITHUB_OUTPUT)
			appendFileSync(process.env.GITHUB_OUTPUT, `evidence=${JSON.stringify(tested)}\n`);
		if (process.env.GITHUB_STEP_SUMMARY)
			appendFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				`CI passed on ${short(sha)}: [run ${tested.number}](${tested.url})\n`,
			);
		return;
	}
	if (command === "security" && rest.length === 3) {
		const [from = "", to = "", target = ""] = rest;
		const commits = gitSecurityCommits(from, to, target);
		if (!commits.length) console.log(`no security-relevant ${target} commits in ${from}..${to}`);
		for (const c of commits) console.log(`${short(c.sha)} ${c.subject}\n  ${c.files.join("\n  ")}`);
		return;
	}
	throw new Error("usage: release-evidence.ts wait-for-ci [sha] | security <from> <to> <target>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((e: Error) => {
		console.error(e.message);
		process.exit(1);
	});
}
