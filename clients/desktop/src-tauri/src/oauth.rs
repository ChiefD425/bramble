//! OAuth sign-in for one-click backup providers (Google Drive, Dropbox), run entirely here so the
//! refresh token never reaches the webview. See docs/cloud-storage-backups.md "Google Drive".

use base64::{
    engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD},
    Engine,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Gdrive,
    Dropbox,
}

/// Everything about a provider that decides where a code or a token may go. Kept here, not taken
/// from the webview, which only ever names the provider. Must match `@core/backup/oauth`.
pub struct ProviderMeta {
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub client_id: &'static str,
    /// Google's Desktop app secret, which Google treats as public. Base64 as in core.
    pub client_secret_b64: Option<&'static str>,
    pub scopes: &'static [&'static str],
    pub auth_params: &'static [(&'static str, &'static str)],
    /// The only origins a stored token is ever sent to.
    pub api_origins: &'static [&'static str],
    /// A fixed loopback port, for a provider that matches it (Dropbox); `None` takes any.
    pub port: Option<u16>,
}

const GDRIVE: ProviderMeta = ProviderMeta {
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    client_id: "1077151297851-7gnnuc2hur3u1jmtuntisn6f8gvhncc4.apps.googleusercontent.com",
    client_secret_b64: Some("R09DU1BYLUpJYzhuMm1GR3hCc3hOdEpaY3BSZl9wV255dWc="),
    scopes: &["https://www.googleapis.com/auth/drive.file"],
    auth_params: &[("access_type", "offline"), ("prompt", "consent")],
    api_origins: &["https://www.googleapis.com"],
    port: None,
};

const DROPBOX: ProviderMeta = ProviderMeta {
    auth_url: "https://www.dropbox.com/oauth2/authorize",
    token_url: "https://api.dropboxapi.com/oauth2/token",
    client_id: "z3dojxeco2znshq",
    client_secret_b64: None,
    scopes: &[
        "files.content.write",
        "files.content.read",
        "files.metadata.read",
    ],
    auth_params: &[("token_access_type", "offline")],
    api_origins: &[
        "https://api.dropboxapi.com",
        "https://content.dropboxapi.com",
    ],
    port: Some(53682),
};

pub fn meta(p: Provider) -> &'static ProviderMeta {
    match p {
        Provider::Gdrive => &GDRIVE,
        Provider::Dropbox => &DROPBOX,
    }
}

pub fn client_secret(p: Provider) -> Option<String> {
    let b64 = meta(p).client_secret_b64?;
    String::from_utf8(B64.decode(b64).ok()?).ok()
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("system randomness");
    URL_SAFE_NO_PAD.encode(buf)
}

/// RFC 7636 pair: a random verifier and its S256 challenge.
pub fn pkce() -> (Zeroizing<String>, String) {
    let verifier = Zeroizing::new(random_url_safe(32));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn random_state() -> String {
    random_url_safe(16)
}

pub fn authorize_url(p: Provider, redirect: &str, challenge: &str, state: &str) -> String {
    let m = meta(p);
    let mut url = reqwest::Url::parse(m.auth_url).expect("static auth url");
    url.query_pairs_mut()
        .append_pair("client_id", m.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect)
        .append_pair("scope", &m.scopes.join(" "))
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .extend_pairs(m.auth_params.iter().copied());
    url.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use sha2::{Digest, Sha256};

    #[test]
    fn constants_match_core() {
        let core = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/core/src/backup/oauth.ts"
        ))
        .unwrap();
        assert!(core.contains(meta(Provider::Gdrive).client_id));
        assert!(core.contains(meta(Provider::Gdrive).client_secret_b64.unwrap()));
        assert!(core.contains(meta(Provider::Dropbox).client_id));
    }

    #[test]
    fn challenge_is_s256_of_verifier() {
        let (verifier, challenge) = pkce();
        let url_safe = |s: &str| {
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        };
        assert!(url_safe(&verifier) && url_safe(&challenge));
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
        assert_ne!(*pkce().0, *verifier);
    }

    #[test]
    fn authorize_url_carries_pkce_state_and_params() {
        let url = authorize_url(Provider::Gdrive, "http://127.0.0.1:4711/", "CH", "ST");
        let url = reqwest::Url::parse(&url).unwrap();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://accounts.google.com"
        );
        let q: std::collections::HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], meta(Provider::Gdrive).client_id);
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:4711/");
        assert_eq!(q["scope"], "https://www.googleapis.com/auth/drive.file");
        assert_eq!(q["code_challenge"], "CH");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["state"], "ST");
    }

    #[test]
    fn dropbox_has_fixed_port_and_no_secret() {
        assert_eq!(meta(Provider::Dropbox).port, Some(53682));
        assert_eq!(meta(Provider::Gdrive).port, None);
        assert!(client_secret(Provider::Dropbox).is_none());
        assert!(client_secret(Provider::Gdrive)
            .unwrap()
            .starts_with("GOCSPX-"));
        assert_ne!(random_state(), random_state());
    }
}
