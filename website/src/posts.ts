import { type CollectionEntry, getCollection } from "astro:content";
import { gateStatus, shows } from "@/doc-gates";

type Post = CollectionEntry<"blog">;

/**
 * Published posts, newest first. Drafts are dropped from every build. A post that waits for a
 * release (`since`) shows in `astro dev` only until that release is out on every target in
 * `sinceOn`, and is then dated by it.
 */
export async function getPosts() {
	const posts = await getCollection(
		"blog",
		({ data }) =>
			!data.draft &&
			(import.meta.env.DEV ||
				!data.since ||
				shows("Since", gateStatus(data.since, data.sinceOn).state)),
	);
	return posts
		.map(datedByRelease)
		.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** The day the last target it waits for shipped, in place of the date it was written. */
function datedByRelease(post: Post): Post {
	if (!post.data.since) return post;
	const { shipped } = gateStatus(post.data.since, post.data.sinceOn);
	const last = shipped
		.map((r) => r.date)
		.reduce<Date | undefined>((a, b) => (a && a > b ? a : b), undefined);
	return last ? { ...post, data: { ...post.data, pubDate: last } } : post;
}

export function formatPostDate(date: Date) {
	return date.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}
