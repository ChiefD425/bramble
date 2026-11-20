// node --test scripts/docs-gates.test.ts
//
// Help-article text that waits for a release: the gate logic in website/src/doc-gates.ts, and the
// status report in scripts/docs-gates.ts. The git lookup runs against a scratch repository with
// real commits and tags, laid out the way releases tag this one.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
	articleGate,
	changedOn,
	type GateStatus,
	parseGates,
	parseOn,
	parseReleaseTag,
	releaseTagsContaining,
	resolveGates,
	rolloutNote,
	shows,
	statusFrom,
	TARGETS,
	type TaggedRelease,
	type Target,
} from "../website/src/doc-gates.ts";
import { describeGates } from "./docs-gates.ts";

const COMMIT = "8edb1d72";
const at = (day: number) => new Date(Date.UTC(2026, 10, day));
const tagged = (tag: string, day: number): TaggedRelease => ({ tag, date: at(day) });

/** A status lookup over fixed tags, standing in for git. */
const lookupFrom =
	(tags: Record<string, TaggedRelease[]>) =>
	(commit: string, on: readonly Target[]): GateStatus =>
		statusFrom(commit, on, tags[commit] ?? []);

describe("parseReleaseTag", () => {
	it("reads every target's tag, iOS's build-numbered one included", () => {
		assert.deepEqual(parseReleaseTag("1.41.0-chromium"), { target: "chromium", version: "1.41.0" });
		assert.deepEqual(parseReleaseTag("1.38.0-firefox"), { target: "firefox", version: "1.38.0" });
		assert.deepEqual(parseReleaseTag("0.20.0-desktop"), { target: "desktop", version: "0.20.0" });
		assert.deepEqual(parseReleaseTag("0.32.0-android"), { target: "android", version: "0.32.0" });
		assert.deepEqual(parseReleaseTag("1.27.0-build217304470-ios"), {
			target: "ios",
			version: "1.27.0",
		});
	});

	it("ignores any other tag", () => {
		for (const tag of ["v1.0.0", "1.0.0-windows", "1.0-desktop", "release-1.0.0-desktop"]) {
			assert.equal(parseReleaseTag(tag), null, tag);
		}
	});
});

describe("parseOn", () => {
	it("means every target when absent or `all`", () => {
		assert.deepEqual(parseOn(undefined), [...TARGETS]);
		assert.deepEqual(parseOn("all"), [...TARGETS]);
	});

	it("takes a comma- or space-separated list", () => {
		assert.deepEqual(parseOn("desktop, android"), ["desktop", "android"]);
		assert.deepEqual(parseOn("chromium firefox"), ["chromium", "firefox"]);
	});

	it("refuses a target no release is tagged for", () => {
		assert.throws(() => parseOn("windows"), /windows/);
		assert.throws(() => parseOn(""), /target/);
	});
});

describe("statusFrom", () => {
	it("is none until a release containing the commit is tagged", () => {
		const s = statusFrom(COMMIT, ["desktop", "android"], [tagged("1.0.0-chromium", 3)]);
		assert.equal(s.state, "none");
		assert.deepEqual(s.shipped, []);
		assert.deepEqual(s.pending, ["desktop", "android"]);
	});

	it("is partial while some targets wait, naming the first release of each", () => {
		const s = statusFrom(
			COMMIT,
			["desktop", "android"],
			[tagged("0.22.0-desktop", 9), tagged("0.21.0-desktop", 5)],
		);
		assert.equal(s.state, "partial");
		assert.deepEqual(s.shipped, [{ target: "desktop", version: "0.21.0", date: at(5) }]);
		assert.deepEqual(s.pending, ["android"]);
	});

	it("is all once every target has a release", () => {
		const s = statusFrom(
			COMMIT,
			["desktop", "android"],
			[tagged("0.33.0-android", 7), tagged("0.21.0-desktop", 5)],
		);
		assert.equal(s.state, "all");
		assert.deepEqual(
			s.shipped.map((r) => r.target),
			["desktop", "android"],
		);
		assert.deepEqual(s.pending, []);
	});
});

describe("shows", () => {
	it("shows Since once shipped everywhere, Until until then, Rollout in between", () => {
		const table = (["none", "partial", "all"] as const).map((state) => [
			shows("Since", state),
			shows("Until", state),
			shows("Rollout", state),
		]);
		assert.deepEqual(table, [
			[false, true, false],
			[false, true, true],
			[true, false, false],
		]);
	});
});

describe("parseGates", () => {
	it("finds each gate with its commit, targets and text, inline or on its own lines", () => {
		const mdx = `| Passkeys | <Since commit="${COMMIT}">Yes</Since><Until commit="${COMMIT}" on="desktop">No</Until> |

<Rollout commit="${COMMIT}" on="desktop, android">Passkeys go with the file</Rollout>
`;
		const gates = parseGates(mdx);
		assert.deepEqual(
			gates.map((g) => [g.kind, g.commit, g.on, g.inner]),
			[
				["Since", COMMIT, [...TARGETS], "Yes"],
				["Until", COMMIT, ["desktop"], "No"],
				["Rollout", COMMIT, ["desktop", "android"], "Passkeys go with the file"],
			],
		);
	});

	it("refuses a gate without a commit, or with an attribute it doesn't know", () => {
		assert.throws(() => parseGates("<Since>x</Since>"), /commit/);
		assert.throws(() => parseGates(`<Since commit="zzz">x</Since>`), /commit/);
		assert.throws(() => parseGates(`<Since commit="${COMMIT}" target="ios">x</Since>`), /target/);
	});

	it("refuses one left open or self-closing, rather than showing it raw", () => {
		assert.throws(() => parseGates(`<Since commit="${COMMIT}">x`), /closed/);
		assert.throws(() => parseGates(`<Until commit="${COMMIT}" />`), /closed/);
	});

	it("refuses a gate inside another", () => {
		assert.throws(
			() => parseGates(`<Since commit="${COMMIT}">a <Until commit="${COMMIT}">b</Until> c</Since>`),
			/inside/,
		);
	});

	// The table of contents comes from the rendered headings, which a gate can't hide.
	it("refuses a heading inside a gate", () => {
		assert.throws(
			() => parseGates(`<Since commit="${COMMIT}">\n\n## New section\n\n</Since>`),
			/heading/,
		);
	});

	it("names the file in what it refuses", () => {
		assert.throws(
			() => parseGates("<Since>x</Since>", "export-your-vault.mdx"),
			/export-your-vault/,
		);
	});
});

describe("resolveGates", () => {
	const mdx = `Before. <Since commit="aaaaaaa">new</Since><Until commit="aaaaaaa">old</Until> <Rollout commit="aaaaaaa">soon</Rollout> After.`;

	it("keeps the text a reader would see, and drops the rest", () => {
		const none = resolveGates(mdx, lookupFrom({}));
		assert.equal(none, "Before. old  After.");
		const partial = resolveGates(mdx, lookupFrom({ aaaaaaa: [tagged("1.0.0-desktop", 1)] }));
		assert.equal(partial, "Before. old soon After.");
		const all = resolveGates(
			mdx,
			lookupFrom({
				aaaaaaa: TARGETS.map((t) => tagged(`1.0.0-${t === "ios" ? "build1-ios" : t}`, 1)),
			}),
		);
		assert.equal(all, "Before. new  After.");
	});
});

describe("rolloutNote", () => {
	const status = (shipped: Target[], pending: Target[]): GateStatus => ({
		commit: COMMIT,
		on: [...shipped, ...pending],
		state: "partial",
		shipped: shipped.map((target, i) => ({ target, version: `1.${i}.0`, date: at(1) })),
		pending,
	});

	it("says where it already is, from which version, and who gets it next", () => {
		assert.equal(
			rolloutNote(status(["chromium"], ["desktop", "android", "ios"])),
			"in the Chrome extension 1.0.0 and later. The desktop app, Android app and iPhone app get it in their next update.",
		);
		assert.equal(
			rolloutNote(status(["chromium", "firefox"], ["ios"])),
			"in the Chrome extension 1.0.0 and Firefox extension 1.1.0 and later. The iPhone app gets it in its next update.",
		);
	});
});

describe("changedOn", () => {
	const mdx = `<Since commit="aaaaaaa" on="desktop">x</Since> <Rollout commit="bbbbbbb" on="desktop, android">y</Rollout> <Until commit="ccccccc" on="desktop">z</Until>`;

	it("is the release that changed what a reader sees", () => {
		const lookup = lookupFrom({
			aaaaaaa: [tagged("1.0.0-desktop", 4)],
			bbbbbbb: [tagged("1.1.0-desktop", 12)],
		});
		// The Since flipped on day 4; the Rollout appeared on day 12; the Until hasn't shipped.
		assert.deepEqual(changedOn(mdx, lookup), at(12));
	});

	it("is nothing while every gate still reads as written", () => {
		assert.equal(changedOn(mdx, lookupFrom({})), undefined);
	});

	it("ignores a Rollout once it has gone again", () => {
		const lookup = lookupFrom({
			bbbbbbb: [tagged("1.1.0-desktop", 12), tagged("0.40.0-android", 20)],
		});
		assert.equal(
			changedOn(`<Rollout commit="bbbbbbb" on="desktop, android">y</Rollout>`, lookup),
			undefined,
		);
	});
});

describe("articleGate", () => {
	it("reads the commit and targets a whole article waits for from its frontmatter", () => {
		const raw = `---\ntitle: New thing\nsince: "${COMMIT}"\nsinceOn: desktop, android\n---\n\nBody.`;
		assert.deepEqual(articleGate(raw), { commit: COMMIT, on: ["desktop", "android"] });
		assert.deepEqual(articleGate(`---\nsince: ${COMMIT}\n---\n`), {
			commit: COMMIT,
			on: [...TARGETS],
		});
	});

	it("is undefined for an article that doesn't wait", () => {
		assert.equal(articleGate("---\ntitle: Old thing\n---\n\nBody."), undefined);
	});
});

describe("releaseTagsContaining", () => {
	let repo: string;
	let first: string;
	let second: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		}).trim();

	before(() => {
		repo = mkdtempSync(join(tmpdir(), "docs-gates-"));
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a"), "1");
		git(repo, "add", "a");
		git(repo, "commit", "-q", "-m", "first");
		first = git(repo, "rev-parse", "HEAD");
		git(repo, "tag", "0.1.0-desktop");
		writeFileSync(join(repo, "a"), "2");
		git(repo, "commit", "-q", "-am", "second");
		second = git(repo, "rev-parse", "HEAD");
		git(repo, "tag", "0.2.0-desktop");
		git(repo, "tag", "1.0.0-build7-ios");
	});

	it("lists the release tags whose commit includes it", () => {
		assert.deepEqual(
			releaseTagsContaining(second, repo)
				.map((t) => t.tag)
				.sort(),
			["0.2.0-desktop", "1.0.0-build7-ios"],
		);
		assert.equal(releaseTagsContaining(first, repo).length, 3);
	});

	it("refuses a commit the history doesn't have", () => {
		assert.throws(() => releaseTagsContaining("0000000", repo), /history/);
	});

	// A shallow clone can't tell which tags contain a commit; reading it as "not shipped" would
	// quietly put old text back on the site.
	it("refuses a shallow clone", () => {
		const shallow = mkdtempSync(join(tmpdir(), "docs-gates-shallow-"));
		git(shallow, "clone", "-q", "--depth", "1", `file://${repo}`, "c");
		assert.throws(() => releaseTagsContaining(second, join(shallow, "c")), /shallow/);
	});
});

describe("describeGates", () => {
	it("reports each gate once per article, with where it stands", () => {
		const files = [
			{
				name: "export-your-vault.mdx",
				mdx: `<Since commit="aaaaaaa">a</Since><Until commit="aaaaaaa">b</Until> <Since commit="bbbbbbb" on="desktop, android">c</Since>`,
			},
			{ name: "auto-lock.mdx", mdx: `<Since commit="ccccccc" on="desktop">d</Since>` },
			{ name: "new-thing.mdx", mdx: `---\nsince: "ddddddd"\n---\n\nAll new.` },
			{ name: "plain.mdx", mdx: "No gates here." },
		];
		const lines = describeGates(
			files,
			lookupFrom({
				bbbbbbb: [tagged("0.21.0-desktop", 3)],
				ccccccc: [tagged("0.21.0-desktop", 3)],
			}),
		);
		assert.deepEqual(lines, [
			"export-your-vault.mdx  aaaaaaa  waiting for chromium, firefox, desktop, android, ios",
			"export-your-vault.mdx  bbbbbbb  in desktop 0.21.0; waiting for android",
			"auto-lock.mdx  ccccccc  shipped everywhere (desktop 0.21.0): keep the Since text, delete the Until and Rollout",
			"new-thing.mdx  ddddddd  whole article, waiting for chromium, firefox, desktop, android, ios",
		]);
	});
});
