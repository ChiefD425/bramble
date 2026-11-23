import type { APIRoute } from "astro";
import { getPosts } from "@/posts";

/** Release tag to the "What's new" post that lists it, for functions/whats-new. */
export const GET: APIRoute = async () => {
	const index: Record<string, string> = {};
	for (const post of await getPosts())
		for (const tag of post.data.releases) index[tag] ??= `/blog/${post.id}`;
	return new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } });
};
