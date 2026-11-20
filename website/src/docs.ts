import { type CollectionEntry, getCollection } from "astro:content";
import { changedOn, gateStatus, shows } from "@/doc-gates";
import { DOC_KINDS, DOC_SECTIONS, type DocSection } from "@/docs-sections";

export { DOC_KINDS, DOC_SECTIONS, type DocSection };
export type Doc = CollectionEntry<"docs">;

export function docHref(doc: Doc) {
	return `/docs/${doc.id}`;
}

export function sectionOf(doc: Doc): DocSection {
	return DOC_SECTIONS.find((s) => s.id === doc.data.section) as DocSection;
}

/** Out, unless it's a draft or waits for a release that isn't on every target yet. */
function published({ draft, since, sinceOn }: Doc["data"]) {
	return !draft && (!since || shows("Since", gateStatus(since, sinceOn).state));
}

/** The frontmatter date, or the release since then that changed what the article shows. */
export function updatedOn(doc: Doc): Date {
	const dates = [doc.data.updatedDate, changedOn(doc.body ?? "", gateStatus, doc.id)];
	if (doc.data.since) {
		const status = gateStatus(doc.data.since, doc.data.sinceOn);
		if (status.state === "all") dates.push(...status.shipped.map((r) => r.date));
	}
	return dates.filter((d) => d !== undefined).reduce((a, b) => (b > a ? b : a));
}

/**
 * Articles in reading order: section, then guides before questions, then `order`.
 * Drafts, and articles waiting for a release (`since`), show in `astro dev` only.
 */
export async function getDocs() {
	const docs = await getCollection("docs", ({ data }) => import.meta.env.DEV || published(data));
	const sectionIndex = (doc: Doc) => DOC_SECTIONS.findIndex((s) => s.id === doc.data.section);
	const kindIndex = (doc: Doc) => (doc.data.kind === "guide" ? 0 : 1);
	return docs.sort(
		(a, b) =>
			sectionIndex(a) - sectionIndex(b) ||
			kindIndex(a) - kindIndex(b) ||
			a.data.order - b.data.order ||
			a.data.title.localeCompare(b.data.title),
	);
}

/** Sections that have at least one article, each with its articles in reading order. */
export function groupBySection(docs: Doc[]) {
	return DOC_SECTIONS.map((section) => ({
		section,
		docs: docs.filter((d) => d.data.section === section.id),
	})).filter((group) => group.docs.length > 0);
}
