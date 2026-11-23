// Where /whats-new/<target>/<version> goes, the "Read more" on the apps' What's new card: the blog
// post that lists the release, else its GitHub release (until the week's post is out, or for a
// release that had none), else the blog. iOS has no GitHub release. See docs/whats-new.md.
// Underscore-prefixed, so Pages treats this as a module rather than a route.

const TARGETS = new Set(["chromium", "firefox", "android", "ios", "desktop"]);
const VERSION = /^\d+(\.\d+){0,2}$/;

/** `posts` maps a release tag to its post's path (src/pages/blog/releases.json.ts). */
export function whatsNewLocation(
	target: string,
	version: string,
	posts: Record<string, string>,
	releasesUrl: string,
): string {
	if (!TARGETS.has(target) || !VERSION.test(version)) return "/blog";
	const tag = `${version}-${target}`;
	const post = posts[tag];
	if (post?.startsWith("/blog/")) return post;
	return target === "ios" ? "/blog" : `${releasesUrl}/tag/${tag}`;
}
