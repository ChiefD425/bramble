import { type PagesContext, RELEASES_URL } from "../../api/_github";
import { whatsNewLocation } from "../_location";

type Context = PagesContext & {
	env: PagesContext["env"] & { ASSETS: { fetch(input: URL): Promise<Response> } };
};

/** The blog's tag-to-post index, or none: a missing index still has somewhere to send people. */
async function posts(context: Context): Promise<Record<string, string>> {
	try {
		const res = await context.env.ASSETS.fetch(new URL("/blog/releases.json", context.request.url));
		return res.ok ? ((await res.json()) as Record<string, string>) : {};
	} catch {
		return {};
	}
}

export const onRequest = async (context: Context): Promise<Response> => {
	const location = whatsNewLocation(
		String(context.params.target ?? ""),
		String(context.params.version ?? ""),
		await posts(context),
		RELEASES_URL,
	);
	return new Response(null, {
		status: 302,
		headers: {
			Location: new URL(location, context.request.url).toString(),
			// Short: a release's post can appear a few days after the release.
			"Cache-Control": "public, max-age=300",
		},
	});
};
