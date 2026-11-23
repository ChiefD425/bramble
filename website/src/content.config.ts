import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { DOC_SECTION_IDS } from "./docs-sections";

const blog = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		/** Meta description and the excerpt on the index. */
		description: z.string(),
		pubDate: z.coerce.date(),
		/** Set when a post is edited after publishing, so a reader knows it still holds. */
		updatedDate: z.coerce.date().optional(),
		/** Hidden from the index and from the build. */
		draft: z.boolean().default(false),
		/** The release tags a "What's new" post covers, for /whats-new/<target>/<version>. */
		releases: z.array(z.string()).default([]),
	}),
});

const docs = defineCollection({
	loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
	schema: z.object({
		title: z.string(),
		/** Meta description, the line under the title, and the search snippet. */
		description: z.string(),
		section: z.enum(DOC_SECTION_IDS),
		kind: z.enum(["guide", "question"]),
		/** Position among the section's articles of the same kind. */
		order: z.number().default(100),
		/** Words people search for that the article doesn't use, and error messages it covers. */
		keywords: z.array(z.string()).default([]),
		updatedDate: z.coerce.date(),
		/** Shown by `astro dev` only, left out of the build. */
		draft: z.boolean().default(false),
		/**
		 * Publish once a release containing this commit is out on every target in `sinceOn`
		 * (README, "Text that waits for a release"). Quote it: YAML reads some hashes as numbers.
		 */
		since: z
			.string()
			.regex(/^[0-9a-f]{7,40}$/, "since takes a commit hash")
			.optional(),
		/** The targets `since` waits for: `all` (the default), or a comma-separated list. */
		sinceOn: z.string().optional(),
	}),
});

export const collections = { blog, docs };
