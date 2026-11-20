// node scripts/docs-gates.ts
//
// Where each help article's release-gated text stands (see website/README.md, "Text that waits
// for a release"): still waiting, out on some targets, or out everywhere, which means the gate
// can go: keep the Since text and delete the Until and Rollout. Exits 1 on a gate the website
// build would refuse. The deploy runs it into the job summary.

import { readdirSync, readFileSync } from "node:fs";
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
const DOCS = join(ROOT, "website/src/content/docs");

function standing(s: GateStatus, done: string): string {
	const shipped = s.shipped.map((r) => `${r.target} ${r.version}`).join(", ");
	const waiting = `waiting for ${s.pending.join(", ")}`;
	if (s.state === "none") return waiting;
	if (s.state === "partial") return `in ${shipped}; ${waiting}`;
	return `shipped everywhere (${shipped}): ${done}`;
}

/** One line per gated commit and target list in each article, and per article that waits. */
export function describeGates(
	files: { name: string; mdx: string }[],
	status: StatusLookup,
): string[] {
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const files = readdirSync(DOCS)
		.filter((f) => /\.mdx?$/.test(f))
		.sort()
		.map((name) => ({ name, mdx: readFileSync(join(DOCS, name), "utf8") }));
	try {
		const lines = describeGates(files, gateStatus);
		console.log(lines.length ? lines.join("\n") : "No help article waits for a release.");
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
