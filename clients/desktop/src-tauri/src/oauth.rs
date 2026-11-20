//! OAuth sign-in for one-click backup providers (Google Drive, Dropbox), run entirely here so the
//! refresh token never reaches the webview. See docs/cloud-storage-backups.md "Google Drive".

use base64::{
    engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD},
    Engine,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
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

type Res<T> = Result<T, String>;

/// A listener for the provider's redirect, and the redirect URI that names it.
pub async fn bind(p: Provider) -> Res<(TcpListener, String)> {
    let fixed = meta(p).port;
    let listener = TcpListener::bind(("127.0.0.1", fixed.unwrap_or(0)))
        .await
        .map_err(|e| match fixed {
            Some(port) if e.kind() == std::io::ErrorKind::AddrInUse => {
                format!("Port {port} is in use. Close the app using it, then connect again.")
            }
            _ => format!("sign-in listener: {e}"),
        })?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("sign-in listener: {e}"))?
        .port();
    Ok((listener, format!("http://127.0.0.1:{port}/")))
}

const SIGNED_IN: &str = "Signed in. You can close this tab and go back to Bramble.";
const NOT_SIGNED_IN: &str = "Sign-in didn't finish. You can close this tab.";

/// The request target of one HTTP request (`/?state=..&code=..`), read up to the blank line.
async fn request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 8192 {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let line = String::from_utf8_lossy(&buf).lines().next()?.to_string();
    line.split(' ').nth(1).map(str::to_string)
}

async fn respond(stream: &mut TcpStream, status: &str, text: &str) {
    let body = format!("<!doctype html><meta charset=utf-8><title>Bramble</title><p>{text}</p>");
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Wait for the provider to send the browser back with a code for `state`. Other requests (a
/// favicon) are answered and ignored; a wrong state or a refusal ends the sign-in.
pub async fn await_code(listener: TcpListener, state: &str, wait: Duration) -> Res<String> {
    let sign_in = async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("sign-in listener: {e}"))?;
            let Some(target) = request_target(&mut stream).await else {
                continue;
            };
            let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{target}")) else {
                continue;
            };
            let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
            if !q.contains_key("code") && !q.contains_key("error") {
                respond(&mut stream, "404 Not Found", NOT_SIGNED_IN).await;
                continue;
            }
            if q.get("state").map(String::as_str) != Some(state) {
                respond(&mut stream, "400 Bad Request", NOT_SIGNED_IN).await;
                return Err("Sign-in could not be verified (state mismatch).".to_string());
            }
            if let Some(error) = q.get("error") {
                respond(&mut stream, "200 OK", NOT_SIGNED_IN).await;
                return Err(format!("Sign-in was cancelled or failed: {error}"));
            }
            respond(&mut stream, "200 OK", SIGNED_IN).await;
            return Ok(q["code"].clone());
        }
    };
    tokio::time::timeout(wait, sign_in)
        .await
        .map_err(|_| "Sign-in timed out. Connect again to try once more.".to_string())?
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

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    /// Send one GET to the listener and return the response text.
    async fn get(addr: &str, target: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    fn addr_of(redirect: &str) -> String {
        redirect
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string()
    }

    #[test]
    fn returns_the_code_for_the_right_state() {
        block_on(async {
            let (listener, redirect) = bind(Provider::Gdrive).await.unwrap();
            let addr = addr_of(&redirect);
            let client =
                tauri::async_runtime::spawn(async move { get(&addr, "/?state=s&code=C1").await });
            let code = await_code(listener, "s", Duration::from_secs(5))
                .await
                .unwrap();
            assert_eq!(code, "C1");
            assert!(client.await.unwrap().contains("Signed in"));
        });
    }

    #[test]
    fn ignores_other_requests_first() {
        block_on(async {
            let (listener, redirect) = bind(Provider::Gdrive).await.unwrap();
            let addr = addr_of(&redirect);
            let client = tauri::async_runtime::spawn(async move {
                get(&addr, "/favicon.ico").await;
                get(&addr, "/?state=s&code=C2").await
            });
            assert_eq!(
                await_code(listener, "s", Duration::from_secs(5))
                    .await
                    .unwrap(),
                "C2"
            );
            client.await.unwrap();
        });
    }

    #[test]
    fn refuses_a_wrong_state() {
        block_on(async {
            let (listener, redirect) = bind(Provider::Gdrive).await.unwrap();
            let addr = addr_of(&redirect);
            let client =
                tauri::async_runtime::spawn(async move { get(&addr, "/?state=evil&code=C").await });
            let err = await_code(listener, "s", Duration::from_secs(5))
                .await
                .unwrap_err();
            assert!(err.contains("could not be verified"), "{err}");
            assert!(client.await.unwrap().contains("didn't finish"));
        });
    }

    #[test]
    fn reports_a_refusal() {
        block_on(async {
            let (listener, redirect) = bind(Provider::Gdrive).await.unwrap();
            let addr = addr_of(&redirect);
            let client = tauri::async_runtime::spawn(async move {
                get(&addr, "/?error=access_denied&state=s").await
            });
            let err = await_code(listener, "s", Duration::from_secs(5))
                .await
                .unwrap_err();
            assert!(err.contains("cancelled"), "{err}");
            client.await.unwrap();
        });
    }

    #[test]
    fn times_out() {
        block_on(async {
            let (listener, _) = bind(Provider::Gdrive).await.unwrap();
            let err = await_code(listener, "s", Duration::from_millis(50))
                .await
                .unwrap_err();
            assert!(err.contains("timed out"), "{err}");
        });
    }

    #[test]
    fn busy_fixed_port_names_it() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 53682));
        block_on(async {
            match bind(Provider::Dropbox).await {
                Err(e) => assert!(e.contains("Port 53682 is in use"), "{e}"),
                // Something else already holds the port, so ours failed to; either way bind errs.
                Ok(_) => panic!("bind should fail while 53682 is held: {held:?}"),
            }
        });
    }
}
