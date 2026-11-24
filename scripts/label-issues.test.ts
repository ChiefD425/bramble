// node --test scripts/label-issues.test.ts
//
// Issue labels from form answers: the mapping, the `needs info` reasons, edits, the API calls, and
// that the forms in .github/ISSUE_TEMPLATE offer exactly the options the mapping knows.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	APPS,
	type Api,
	AREAS,
	HEADINGS,
	LABELS,
	labelIssue,
	labelsFor,
	MARKER,
	missing,
	needsInfoComment,
	relabel,
} from "./label-issues.ts";

const CHROME =
	"Browser extension in Chrome or another Chromium browser (Edge / Brave / Vivaldi / Opera / Arc)";
const FIREFOX =
	"Browser extension in Firefox or a Firefox-based browser (Zen / LibreWolf / Floorp)";
const LINK = "Link between the browser extension and the desktop app";

/** A body as GitHub renders a bug report form, with an empty answer as "_No response_". */
function bug(a: {
	apps?: string[];
	area?: string[];
	version?: string;
	devices?: string;
	happened?: string;
}): string {
	const field = (label: string, value: string | undefined) =>
		`### ${label}\n\n${value || "_No response_"}`;
	return [
		field(HEADINGS.apps[0], a.apps?.join(", ")),
		field(HEADINGS.area, a.area?.join(", ")),
		field(HEADINGS.version, a.version ?? "0.22.0"),
		field("Which browser or system?", "macOS"),
		field("What happened?", a.happened ?? "It broke."),
		field("Steps to reproduce", undefined),
		field("What did you expect to happen?", undefined),
		field(HEADINGS.devices, a.devices),
		field("Sync log", undefined),
		field("Screenshots or anything else", undefined),
	].join("\n\n");
}

function feature(apps: string[], area: string[]): string {
	return [
		`### ${HEADINGS.apps[1]}\n\n${apps.join(", ")}`,
		`### ${HEADINGS.area}\n\n${area.join(", ")}`,
		"### What would it help you do?\n\nSort by name.",
		"### How could it work?\n\n_No response_",
	].join("\n\n");
}

describe("labelsFor", () => {
	it("labels each app picked", () => {
		assert.deepEqual(labelsFor(bug({ apps: [CHROME], area: ["Autofill"] })), [
			"chromium",
			"autofill",
		]);
		assert.deepEqual(labelsFor(bug({ apps: ["Desktop app on Linux"], area: ["Backups"] })), [
			"desktop",
			"linux",
			"backups",
		]);
	});

	it("adds an umbrella label only when both of its targets are picked", () => {
		const both = labelsFor(bug({ apps: [CHROME, FIREFOX], area: ["Passkeys"] }));
		assert.deepEqual(both, ["chromium", "firefox", "extension", "passkeys"]);
		const phones = labelsFor(
			bug({ apps: ["iOS app (iPhone or iPad)", "Android app"], area: ["Autofill"] }),
		);
		assert.deepEqual(phones, ["iOS", "android", "mobile", "autofill"]);
		assert.ok(!labelsFor(bug({ apps: ["Android app"], area: ["Autofill"] })).includes("mobile"));
	});

	it("labels every area picked", () => {
		const labels = labelsFor(
			feature(["Every app"], ["Import or export", "Two-factor codes (TOTP)", "Translations"]),
		);
		assert.deepEqual(labels, ["import/export", "totp", "translations"]);
	});

	it("gives nothing for Every app or Something else", () => {
		assert.deepEqual(labelsFor(feature(["Every app"], ["Something else"])), []);
	});

	it("ignores an option it does not know, and a body that is not from a form", () => {
		assert.deepEqual(labelsFor(feature(["Safari extension", "Android app"], ["Autofill"])), [
			"android",
			"autofill",
		]);
		assert.deepEqual(labelsFor("Chrome is broken. Android too. Autofill, Sync."), []);
	});

	it("reads only the dropdowns' own answers, not headings typed into a later field", () => {
		const body = bug({
			apps: ["Android app"],
			area: ["Autofill"],
			happened: `### ${HEADINGS.apps[0]}\n\n${CHROME}\n\n### ${HEADINGS.area}\n\nSync between devices`,
		});
		assert.deepEqual(labelsFor(body), ["android", "autofill"]);
	});

	it("reads Windows line endings", () => {
		const body = bug({ apps: ["Desktop app on Windows"], area: ["Install and updates"] });
		assert.deepEqual(labelsFor(body.replace(/\n/g, "\r\n")), ["desktop", "windows", "install"]);
	});

	it("only ever gives labels it can create", () => {
		for (const labels of [...Object.values(APPS), ...Object.values(AREAS)])
			for (const l of labels) assert.ok(l in LABELS, l);
	});
});

describe("missing", () => {
	it("asks for the devices on a sync or desktop link problem without them", () => {
		for (const area of ["Sync between devices", LINK]) {
			assert.deepEqual(missing(bug({ apps: ["Android app"], area: [area] })), ["devices"]);
			const body = bug({ apps: ["Android app"], area: [area], devices: "Android 0.34.0" });
			assert.deepEqual(missing(body), []);
		}
	});

	it("does not ask for devices when neither is involved", () => {
		assert.deepEqual(missing(bug({ apps: ["Android app"], area: ["Autofill"] })), []);
	});

	it("asks for a version that has no version number in it", () => {
		for (const version of ["latest", "the newest one", "v1"])
			assert.deepEqual(missing(bug({ apps: ["Android app"], area: ["Autofill"], version })), [
				"version",
			]);
		for (const version of ["0.34.0", "v1.43", "Desktop 0.22.0, Chrome extension 1.43.0"])
			assert.deepEqual(missing(bug({ apps: ["Android app"], area: ["Autofill"], version })), []);
	});

	it("never asks on a feature request", () => {
		assert.deepEqual(missing(feature(["Android app"], ["Sync between devices"])), []);
	});

	it("adds needs info while something is missing", () => {
		const body = bug({ apps: ["Android app"], area: ["Sync between devices"] });
		assert.ok(labelsFor(body).includes("needs info"));
	});
});

describe("relabel", () => {
	const before = bug({ apps: [CHROME], area: ["Sync between devices"] });

	it("adds everything for a new issue", () => {
		assert.deepEqual(relabel(null, before), {
			add: ["chromium", "sync", "needs info"],
			remove: [],
		});
	});

	it("moves only the labels whose answers changed", () => {
		const after = bug({
			apps: [FIREFOX],
			area: ["Sync between devices"],
			devices: "Firefox 1.43.0",
		});
		assert.deepEqual(relabel(before, after), {
			add: ["firefox"],
			remove: ["chromium", "needs info"],
		});
	});

	it("changes nothing when the answers did not change", () => {
		const after = before.replace("It broke.", "It broke again.");
		assert.deepEqual(relabel(before, after), { add: [], remove: [] });
	});
});

describe("needsInfoComment", () => {
	it("starts with the marker and asks only for what is missing", () => {
		const text = needsInfoComment(
			bug({ apps: ["Android app"], area: ["Sync between devices"], version: "latest" }),
		);
		assert.ok(text.startsWith(MARKER));
		assert.match(text, /\*\*Bramble version\*\*/);
		assert.match(text, /\*\*Every device in the sync or link\*\*/);
		assert.doesNotMatch(text, /—/);
	});
});

describe("labelIssue", () => {
	function fakeApi(comments: { body: string }[] = []) {
		const calls: string[] = [];
		const api: Api = async (method, path, body) => {
			calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
			if (method === "POST" && path.endsWith("/repos/o/r/labels"))
				return { status: (body as { name: string }).name === "sync" ? 201 : 422, data: {} };
			if (method === "GET") return { status: 200, data: comments };
			if (method === "POST" && path.endsWith("/comments")) return { status: 201, data: {} };
			if (method === "DELETE")
				return { status: path.endsWith("needs%20info") ? 404 : 200, data: [] };
			return { status: 200, data: [] };
		};
		return { api, calls };
	}
	const syncBug = bug({ apps: ["Android app"], area: ["Sync between devices"] });

	it("creates the labels, adds them, and asks once for what is missing", async () => {
		const { api, calls } = fakeApi();
		const event = { action: "opened", issue: { number: 7, body: syncBug } };
		assert.equal(await labelIssue(event, "o/r", api), "+android +sync +needs info");
		assert.deepEqual(
			calls.map((c) => c.split(" {")[0]),
			[
				"POST /repos/o/r/labels",
				"POST /repos/o/r/labels",
				"POST /repos/o/r/labels",
				"POST /repos/o/r/issues/7/labels",
				"GET /repos/o/r/issues/7/comments?per_page=100",
				"POST /repos/o/r/issues/7/comments",
			],
		);
		assert.match(calls[0] ?? "", /"color":"1dafac"/);
		assert.match(calls[3] ?? "", /\{"labels":\["android","sync","needs info"\]\}/);
	});

	it("does not ask twice", async () => {
		const { api, calls } = fakeApi([{ body: `${MARKER}\nThanks` }]);
		await labelIssue({ action: "opened", issue: { number: 7, body: syncBug } }, "o/r", api);
		assert.ok(!calls.some((c) => c.startsWith("POST /repos/o/r/issues/7/comments")));
	});

	it("removes what an edit took away, even if someone already did", async () => {
		const { api, calls } = fakeApi();
		const after = bug({ apps: ["Android app"], area: ["Autofill"] });
		const event = {
			action: "edited",
			issue: { number: 7, body: after },
			changes: { body: { from: syncBug } },
		};
		assert.equal(await labelIssue(event, "o/r", api), "+autofill -sync -needs info");
		assert.ok(calls.includes("DELETE /repos/o/r/issues/7/labels/sync"));
		assert.ok(calls.includes("DELETE /repos/o/r/issues/7/labels/needs%20info"));
	});

	it("does nothing for a title-only edit or another action", async () => {
		const { api, calls } = fakeApi();
		const issue = { number: 7, body: syncBug };
		assert.equal(await labelIssue({ action: "edited", issue, changes: {} }, "o/r", api), "");
		assert.equal(await labelIssue({ action: "closed", issue }, "o/r", api), "");
		assert.deepEqual(calls, []);
	});

	it("fails the run when GitHub refuses", async () => {
		const api: Api = async () => ({ status: 403, data: {} });
		const event = { action: "opened", issue: { number: 7, body: syncBug } };
		await assert.rejects(labelIssue(event, "o/r", api), /creating label android: 403/);
	});
});

/** Each field of a form, by id, with its type, label and options, in form order. */
function formFields(file: string) {
	const fields: { type: string; id: string; label: string; options: string[] }[] = [];
	let inOptions = false;
	for (const line of readFileSync(
		new URL(`../.github/ISSUE_TEMPLATE/${file}`, import.meta.url),
		"utf8",
	).split("\n")) {
		const type = line.match(/^ {2}- type: (\w+)/)?.[1];
		if (type) fields.push({ type, id: "", label: "", options: [] });
		const field = fields.at(-1);
		if (!field) continue;
		field.id ||= line.match(/^ {4}id: (.+)/)?.[1] ?? "";
		field.label ||= line.match(/^ {6}label: (.+)/)?.[1] ?? "";
		if (/^ {6}options:/.test(line)) inOptions = true;
		else if (!/^ {8}- /.test(line)) inOptions = false;
		const option = line.match(/^ {8}- (.+)/)?.[1];
		if (inOptions && option) field.options.push(option);
	}
	return fields;
}

describe("the issue forms", () => {
	const forms = { bug: formFields("bug_report.yml"), feature: formFields("feature_request.yml") };

	it("offer exactly the options the labels come from", () => {
		const offered = (id: string) => [
			...new Set(Object.values(forms).flatMap((f) => f.find((x) => x.id === id)?.options ?? [])),
		];
		assert.deepEqual(offered("apps").sort(), Object.keys(APPS).sort());
		assert.deepEqual(offered("area").sort(), Object.keys(AREAS).sort());
		for (const option of [...Object.keys(APPS), ...Object.keys(AREAS)])
			assert.ok(!option.includes(","), `"${option}" would split into two answers`);
	});

	it("ask under the headings the labels are read from", () => {
		const label = (form: keyof typeof forms, id: string) =>
			forms[form].find((f) => f.id === id)?.label;
		assert.equal(label("bug", "apps"), HEADINGS.apps[0]);
		assert.equal(label("feature", "apps"), HEADINGS.apps[1]);
		assert.equal(label("bug", "area"), HEADINGS.area);
		assert.equal(label("feature", "area"), HEADINGS.area);
		assert.equal(label("bug", "version"), HEADINGS.version);
		assert.equal(label("bug", "devices"), HEADINGS.devices);
	});

	it("put the dropdowns before any field a reporter can type headings into", () => {
		for (const fields of Object.values(forms)) {
			const lastDropdown = fields.findLastIndex((f) => f.type === "dropdown");
			const firstTextarea = fields.findIndex((f) => f.type === "textarea");
			assert.ok(lastDropdown < firstTextarea);
		}
	});
});
