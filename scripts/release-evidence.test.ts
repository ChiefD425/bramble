// node --test scripts/release-evidence.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	type CiDeps,
	evidenceSections,
	type PageInput,
	securityCommits,
	type Tested,
	waitForCi,
} from "./release-evidence.ts";
import {
	PLATFORM_PATHS,
	pathPattern,
	SECURITY_PATHS,
	securityFiles,
	shipsIn,
} from "./release-paths.ts";

describe("securityFiles", () => {
	it("counts shared crypto in every app", () => {
		for (const target of Object.keys(PLATFORM_PATHS))
			assert.deepEqual(securityFiles(["packages/core-rust/src/lib.rs"], target), [
				"packages/core-rust/src/lib.rs",
			]);
	});

	it("leaves out tests, fixtures and docs under a sensitive path", () => {
		const files = [
			"packages/core/src/sync/roster.test.ts",
			"clients/extension/src/fixtures/sites/a.html",
			"clients/mobile/android/app/src/test/java/app/bramble/mobile/TotpTest.kt",
			"clients/desktop/macos/BrambleAutoFill/Tests/AppSessionTests.swift",
			"packages/core/src/vault/entry-mutations.harness.ts",
			"packages/core-rust/README.md",
		];
		for (const target of Object.keys(PLATFORM_PATHS))
			assert.deepEqual(securityFiles(files, target), []);
	});

	it("keeps each app's native code to that app", () => {
		const kotlin = "clients/mobile/android/app/src/main/java/app/bramble/mobile/TrustedBrowsers.kt";
		const swift = "clients/mobile/ios/App/App/NativeCrypto.swift";
		assert.deepEqual(securityFiles([kotlin, swift], "android"), [kotlin]);
		assert.deepEqual(securityFiles([kotlin, swift], "ios"), [swift]);
		assert.deepEqual(securityFiles([kotlin, swift], "chromium"), []);
	});

	it("gives each extension its own manifest", () => {
		const m = "packages/manifests/firefox/manifest.json";
		assert.deepEqual(securityFiles([m], "firefox"), [m]);
		assert.deepEqual(securityFiles([m], "chromium"), []);
	});

	it("matches a star within one path segment only", () => {
		assert.deepEqual(
			securityFiles(
				[
					"packages/core/src/app/hooks/useWebauthnUnlock.ts",
					"packages/core/src/app/hooks/useWhatsNew.ts",
					"clients/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json",
				],
				"ios",
			),
			["packages/core/src/app/hooks/useWebauthnUnlock.ts"],
		);
	});

	it("does not take a sibling that only shares a name prefix", () => {
		assert.deepEqual(securityFiles(["packages/core/src/vault-format.test-data.ts"], "ios"), []);
		assert.deepEqual(securityFiles(["packages/core/src/vaults/x.ts"], "ios"), []);
	});

	it("names a path on the list that no longer exists", () => {
		const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
		const shipped = tracked.filter((f) => Object.keys(PLATFORM_PATHS).some((t) => shipsIn(f, t)));
		const gone = SECURITY_PATHS.filter(
			(p) => !shipped.some((f) => pathPattern(p.path).test(f)),
		).map((p) => p.path);
		assert.deepEqual(gone, []);
	});
});

describe("securityCommits", () => {
	const log = [
		"",
		"aaa\tfix(autofill): the update card no longer picks a login for you\n\nclients/extension/src/content/corner-prompt.ts\nwebsite/src/x.mdx\n",
		"bbb\tchore(release): chromium 1.43.0\n\npackages/manifests/chromium/manifest.json\n",
		"ccc\tfeat(ui): a new icon\n\npackages/core/src/app/components/Icon.tsx\n",
		"ddd\ttest(sync): wait for the hello\n\npackages/core/src/sync/mesh.test.ts\n",
	].join("\0");

	it("keeps commits that change shipped, sensitive files, and skips version bumps", () => {
		assert.deepEqual(securityCommits(log, "chromium"), [
			{
				sha: "aaa",
				subject: "fix(autofill): the update card no longer picks a login for you",
				files: ["clients/extension/src/content/corner-prompt.ts"],
			},
		]);
	});

	it("leaves out a commit to another app's code", () => {
		assert.deepEqual(securityCommits(log, "android"), []);
	});
});

const run = (over: Partial<Record<string, unknown>> = {}) => ({
	id: 7,
	run_number: 100,
	run_attempt: 1,
	head_sha: "abc123def",
	event: "push",
	status: "completed",
	conclusion: "success",
	html_url: "https://github.com/o/r/actions/runs/7",
	...over,
});

/** A fake API that answers each runs query with the next of `polls`, and a clock that moves per sleep. */
function fake(polls: unknown[][]) {
	let t = 0;
	const logs: string[] = [];
	const asked: string[] = [];
	const deps: CiDeps = {
		api: async (path) => {
			asked.push(path);
			if (path.includes("/jobs"))
				return {
					jobs: [
						{ name: "CI", conclusion: "success", id: 1 },
						{ name: "Desktop (Windows installer)", conclusion: "skipped", id: 2 },
					],
				};
			return { workflow_runs: polls.shift() ?? [] };
		},
		sleep: async (ms) => {
			t += ms;
		},
		now: () => t,
		log: (l) => logs.push(l),
	};
	return { deps, logs, asked };
}

describe("waitForCi", () => {
	it("waits for a running CI and returns the run with its jobs", async () => {
		const { deps, logs } = fake([
			[run({ status: "in_progress", conclusion: null })],
			[run({ status: "in_progress", conclusion: null })],
			[run()],
		]);
		const tested = await waitForCi("o/r", "abc123def", deps);
		assert.deepEqual(tested, {
			sha: "abc123def",
			url: "https://github.com/o/r/actions/runs/7",
			number: 100,
			attempt: 1,
			jobs: [
				{ name: "CI", conclusion: "success" },
				{ name: "Desktop (Windows installer)", conclusion: "skipped" },
			],
		});
		assert.equal(logs.length, 1, "says it is waiting once, not once per poll");
	});

	it("refuses a failed run and links it", async () => {
		const { deps } = fake([[run({ conclusion: "failure" })]]);
		await assert.rejects(waitForCi("o/r", "abc123def", deps), /CI ended failure.*runs\/7/s);
	});

	it("judges the newest run, so a re-run that passed counts", async () => {
		const { deps } = fake([
			[run({ run_number: 99, conclusion: "failure" }), run({ run_number: 101, id: 8 })],
		]);
		assert.equal((await waitForCi("o/r", "abc123def", deps)).number, 101);
	});

	it("ignores pull request runs and other commits", async () => {
		const { deps } = fake([
			[run({ event: "pull_request" }), run({ head_sha: "other" })],
			[run({ event: "pull_request" })],
		]);
		await assert.rejects(
			waitForCi("o/r", "abc123def", deps, { noRunMs: 30_000, pollMs: 30_000 }),
			/CI never ran on abc123de/,
		);
	});

	it("gives up on a run that never finishes", async () => {
		const polls = Array.from({ length: 10 }, () => [run({ status: "queued", conclusion: null })]);
		const { deps } = fake(polls);
		await assert.rejects(
			waitForCi("o/r", "abc123def", deps, { timeoutMs: 60_000, pollMs: 30_000 }),
			/still running on abc123de after 1 min/,
		);
	});

	it("asks only for this commit's CI runs", async () => {
		const { deps, asked } = fake([[run()]]);
		await waitForCi("o/r", "abc123def", deps);
		assert.equal(
			asked[0],
			"/repos/o/r/actions/workflows/ci.yml/runs?head_sha=abc123def&per_page=20",
		);
	});
});

describe("evidenceSections", () => {
	const tested: Tested = {
		sha: "abc123def456",
		url: "https://github.com/o/r/actions/runs/7",
		number: 100,
		attempt: 1,
		jobs: [
			{ name: "CI", conclusion: "success" },
			{ name: "E2E (sync, two peers)", conclusion: "success" },
			{ name: "Desktop (Windows installer)", conclusion: "skipped" },
		],
	};
	const page = (over: Partial<PageInput> = {}): string =>
		evidenceSections({
			repo: "o/r",
			target: "chromium",
			tag: "1.43.0-chromium",
			prev: "1.42.0-chromium",
			head: "fff000",
			commits: [],
			tested,
			runUrl: "https://github.com/o/r/actions/runs/9",
			...over,
		});

	it("says plainly when nothing sensitive changed", () => {
		const md = page();
		assert.match(md, /^## Security-relevant changes\n\nNone\. No commit since 1\.42\.0-chromium/);
		assert.match(md, /\[scripts\/release-paths\.ts\]\(https:\/\/github\.com\/o\/r\/blob\/fff000\//);
		assert.match(md, /release-evidence\.ts security 1\.42\.0-chromium 1\.43\.0-chromium chromium/);
	});

	it("lists each sensitive commit with a link", () => {
		const md = page({
			commits: [{ sha: "9b793066aaaa", subject: "fix(autofill): pick nothing", files: [] }],
		});
		assert.match(md, /This commit since 1\.42\.0-chromium/);
		assert.match(
			md,
			/- \[9b793066\]\(https:\/\/github\.com\/o\/r\/commit\/9b793066aaaa\) fix\(autofill\): pick nothing/,
		);
	});

	it("names the CI run, what passed and what was skipped", () => {
		const md = page();
		assert.match(
			md,
			/\[CI run 100\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\) passed on \[abc123de\]/,
		);
		assert.match(
			md,
			/Passed: CI, E2E \(sync, two peers\)\. Skipped: Desktop \(Windows installer\)\./,
		);
		assert.match(md, /\[This release run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\)/);
		assert.doesNotMatch(md, /attempt/);
	});

	it("says when CI passed only on a re-run", () => {
		assert.match(page({ tested: { ...tested, attempt: 2 } }), /, on attempt 2,/);
	});

	it("says no CI run is attached to a release cut locally", () => {
		const md = page({ tested: null, runUrl: null });
		assert.match(md, /maintainer's machine.*No CI run is attached/);
		assert.doesNotMatch(md, /Build\./);
	});

	it("adds the update log for desktop only", () => {
		assert.match(page({ target: "desktop", tag: "0.22.0-desktop" }), /Sigsum/);
		assert.doesNotMatch(page(), /Sigsum/);
	});

	it("handles a first release", () => {
		const md = page({ prev: "" });
		assert.match(md, /first chromium release/);
		assert.doesNotMatch(md, /release-evidence\.ts security/);
	});
});
