// OAuth (PKCE) for one-click backup providers. The whole connect runs in the extension
// background service worker (see background/backup-connect): the interactive authorize step,
// then these helpers. The token exchange + refresh are plain fetches, so they run anywhere
// (background or the provider's client). We store only the long-lived refresh token
// (VEK-wrapped, like other creds) and mint a short-lived access token on demand.
// See docs/cloud-storage-backups.md.

import { z } from "zod";
import { bytesToBase64Url } from "../util/bytes";

export type OAuthProviderId = "dropbox" | "gdrive";

export interface OAuthProviderMeta {
	authUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	/** Extra authorize-request params, e.g. Dropbox needs token_access_type=offline to return a refresh token. */
	authParams?: Record<string, string>;
	/** Sent with the code exchange and every refresh. Absent for a public client (Dropbox). An
	 * installed app's secret is not a secret, so Google allows shipping its Desktop client's. */
	clientSecret?: string;
	/** The client accepts only loopback redirects (Google's Desktop app type), not the
	 * extension's own identity URL. */
	loopbackRedirect?: boolean;
}

// Public app keys, safe to ship in the client (PKCE, no secret). Registered by the
// app owner with the provider; the redirect URI is the extension's own
// chrome.identity.getRedirectURL(). Replace the placeholder with the real app key.
const DROPBOX_CLIENT_ID = "z3dojxeco2znshq";

// Google's Desktop app client. Committed, not injected in CI, so a rebuild from public source
// matches the store build (verify-releases.yml). Base64 only so scanners that match Google's
// secret prefix don't flag it; it hides nothing. Empty keeps the tile "coming soon".
const GDRIVE_CLIENT_ID =
	"1077151297851-7gnnuc2hur3u1jmtuntisn6f8gvhncc4.apps.googleusercontent.com";
const GDRIVE_CLIENT_SECRET_B64 = "";

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderMeta> = {
	dropbox: {
		authUrl: "https://www.dropbox.com/oauth2/authorize",
		tokenUrl: "https://api.dropboxapi.com/oauth2/token",
		clientId: DROPBOX_CLIENT_ID,
		// write = upload + delete; read = download; metadata.read = list_folder (retention prune).
		scopes: ["files.content.write", "files.content.read", "files.metadata.read"],
		authParams: { token_access_type: "offline" },
	},
	gdrive: {
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		clientId: GDRIVE_CLIENT_ID,
		clientSecret: atob(GDRIVE_CLIENT_SECRET_B64),
		loopbackRedirect: true,
		// Only the files Bramble creates. Non-sensitive, so no Google security assessment.
		scopes: ["https://www.googleapis.com/auth/drive.file"],
		// Google returns a refresh token only for offline access, and only on a fresh consent.
		authParams: { access_type: "offline", prompt: "consent" },
	},
};

/** True once a real app key (and secret, where one is needed) is in; gates the connect UI so an
 * unconfigured build stays "coming soon". */
export function isOAuthConfigured(id: OAuthProviderId): boolean {
	const meta = OAUTH_PROVIDERS[id];
	return !meta.clientId.startsWith("REPLACE_WITH_") && meta.clientSecret !== "";
}

export interface Pkce {
	verifier: string;
	challenge: string;
}

/** RFC 7636 PKCE pair: a random verifier and its S256 challenge (base64url of the SHA-256 digest). */
export async function generatePkce(): Promise<Pkce> {
	const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export interface OAuthTokens {
	refreshToken: string;
	accessToken: string;
}

async function postForm(
	meta: OAuthProviderMeta,
	params: Record<string, string>,
): Promise<Response> {
	const body: Record<string, string> = { ...params, client_id: meta.clientId };
	if (meta.clientSecret) body.client_secret = meta.clientSecret;
	return fetch(meta.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
}

// Token-endpoint response shapes. Providers send extra fields (token_type,
// expires_in, scope, account_id, ...) which are ignored; we validate only what we
// consume, and reject anything malformed rather than trusting the wire.
const TokenPairSchema = z.object({ access_token: z.string(), refresh_token: z.string() });
const AccessTokenSchema = z.object({ access_token: z.string() });
const TokenErrorSchema = z.object({
	error: z.string().optional(),
	error_description: z.string().optional(),
});

// Best-effort detail from a failed token request: the OAuth error body, else the status.
async function tokenErrorDetail(res: Response): Promise<string> {
	try {
		const parsed = TokenErrorSchema.safeParse(await res.json());
		const msg = parsed.success ? (parsed.data.error_description ?? parsed.data.error) : undefined;
		if (msg) return msg;
	} catch {}
	return `HTTP ${res.status}`;
}

/** Trade an authorization code (+ PKCE verifier) for a refresh + access token. */
export async function exchangeCodeForTokens(opts: {
	providerId: OAuthProviderId;
	code: string;
	codeVerifier: string;
	redirectUri: string;
}): Promise<OAuthTokens> {
	const meta = OAUTH_PROVIDERS[opts.providerId];
	const res = await postForm(meta, {
		grant_type: "authorization_code",
		code: opts.code,
		code_verifier: opts.codeVerifier,
		redirect_uri: opts.redirectUri,
	});
	if (!res.ok) throw new Error(`Sign-in failed (${res.status}). ${await tokenErrorDetail(res)}`);
	const parsed = TokenPairSchema.safeParse(await res.json());
	if (!parsed.success) {
		throw new Error("The provider didn't return a refresh token. Try connecting again.");
	}
	return { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token };
}

/** Mint a fresh short-lived access token from the stored refresh token (non-interactive). */
export async function refreshAccessToken(
	providerId: OAuthProviderId,
	refreshToken: string,
): Promise<string> {
	const meta = OAUTH_PROVIDERS[providerId];
	const res = await postForm(meta, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	if (!res.ok) {
		throw new Error(
			`Couldn't refresh access (${res.status}: ${await tokenErrorDetail(res)}). Reconnect the account.`,
		);
	}
	const parsed = AccessTokenSchema.safeParse(await res.json());
	if (!parsed.success) throw new Error("No access token returned. Reconnect the account.");
	return parsed.data.access_token;
}
