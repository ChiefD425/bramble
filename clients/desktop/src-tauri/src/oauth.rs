//! OAuth sign-in for one-click backup providers (Google Drive, Dropbox), run entirely here so the
//! refresh token never reaches the webview. See docs/cloud-storage-backups.md "Google Drive".

use base64::{
    engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD},
    Engine,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
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

/// One token-endpoint call, with the client's ID (and secret, where it has one) added.
async fn token_request(
    p: Provider,
    token_url: &str,
    params: &[(&str, &str)],
) -> Result<serde_json::Value, (u16, String)> {
    let m = meta(p);
    let secret = client_secret(p).map(Zeroizing::new);
    let mut form: Vec<(&str, &str)> = params.to_vec();
    form.push(("client_id", m.client_id));
    if let Some(secret) = secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| (0, format!("http client: {e}")))?;
    // Url's own serializer is application/x-www-form-urlencoded, so no reqwest `form` feature.
    let mut encoder = reqwest::Url::parse("http://form.invalid/").expect("static url");
    encoder.query_pairs_mut().extend_pairs(form);
    let encoded = Zeroizing::new(encoder.query().unwrap_or_default().to_string());
    let res = client
        .post(token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(encoded.to_string())
        .send()
        .await
        .map_err(|e| (0, format!("request failed: {e}")))?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let detail = body
        .get("error_description")
        .or_else(|| body.get("error"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP {status}"));
    Err((status, detail))
}

/// Trade an authorization code (+ PKCE verifier) for the long-lived refresh token.
pub async fn exchange(
    p: Provider,
    token_url: &str,
    code: &str,
    verifier: &str,
    redirect: &str,
) -> Res<Zeroizing<String>> {
    let body = token_request(
        p,
        token_url,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
        ],
    )
    .await
    .map_err(|(status, detail)| format!("Sign-in failed ({status}). {detail}"))?;
    body.get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|t| Zeroizing::new(t.to_string()))
        .ok_or_else(|| "The provider didn't return a refresh token. Try connecting again.".into())
}

/// Access tokens minted from stored refresh tokens, by credential account, until shortly before
/// they expire. Only ever in this process's memory.
#[derive(Default)]
pub struct TokenCache {
    entries: std::sync::Mutex<HashMap<String, (Zeroizing<String>, Instant)>>,
}

impl TokenCache {
    pub fn global() -> &'static TokenCache {
        static CACHE: OnceLock<TokenCache> = OnceLock::new();
        CACHE.get_or_init(TokenCache::default)
    }

    pub async fn bearer(
        &self,
        key: &str,
        p: Provider,
        token_url: &str,
        refresh: &str,
    ) -> Res<Zeroizing<String>> {
        if let Some((token, until)) = self.entries.lock().unwrap().get(key) {
            if Instant::now() < *until {
                return Ok(token.clone());
            }
        }
        let body = token_request(
            p,
            token_url,
            &[("grant_type", "refresh_token"), ("refresh_token", refresh)],
        )
        .await
        .map_err(|(status, detail)| {
            format!("Couldn't refresh access ({status}: {detail}). Reconnect the account.")
        })?;
        let token = body
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(|t| Zeroizing::new(t.to_string()))
            .ok_or("No access token returned. Reconnect the account.")?;
        // A minute short of what the provider says, so a token is never used as it expires.
        let lifetime = body
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(3600);
        let until = Instant::now() + Duration::from_secs(lifetime.saturating_sub(60));
        self.entries
            .lock()
            .unwrap()
            .insert(key.to_string(), (token.clone(), until));
        Ok(token)
    }

    /// Forget a token the provider refused, so the next request mints a fresh one.
    pub fn evict(&self, key: &str) {
        self.entries.lock().unwrap().remove(key);
    }
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

    /// A token endpoint that answers each request with the next canned reply and records the
    /// form bodies it was sent.
    fn fake_token_server(
        replies: Vec<(u16, &'static str)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in replies {
                let Ok((mut s, _)) = listener.accept() else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = s.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + len {
                            record
                                .lock()
                                .unwrap()
                                .push(text[end + 4..end + 4 + len].to_string());
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                s.write_all(reply.as_bytes()).unwrap();
            }
        });
        (url, seen)
    }

    fn form(body: &str) -> HashMap<String, String> {
        reqwest::Url::parse(&format!("http://x/?{body}"))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    #[test]
    fn exchange_sends_code_verifier_redirect_and_gdrive_secret() {
        let (url, seen) = fake_token_server(vec![(
            200,
            r#"{"access_token":"AT","refresh_token":"RT","expires_in":3599}"#,
        )]);
        let refresh = block_on(exchange(
            Provider::Gdrive,
            &url,
            "CODE",
            "VER",
            "http://127.0.0.1:9/",
        ))
        .unwrap();
        assert_eq!(*refresh, "RT");
        let f = form(&seen.lock().unwrap()[0]);
        assert_eq!(f["grant_type"], "authorization_code");
        assert_eq!(f["code"], "CODE");
        assert_eq!(f["code_verifier"], "VER");
        assert_eq!(f["redirect_uri"], "http://127.0.0.1:9/");
        assert_eq!(f["client_id"], meta(Provider::Gdrive).client_id);
        assert_eq!(f["client_secret"], client_secret(Provider::Gdrive).unwrap());
    }

    #[test]
    fn dropbox_exchange_sends_no_secret() {
        let (url, seen) =
            fake_token_server(vec![(200, r#"{"access_token":"AT","refresh_token":"RT"}"#)]);
        block_on(exchange(
            Provider::Dropbox,
            &url,
            "CODE",
            "VER",
            "http://127.0.0.1:53682/",
        ))
        .unwrap();
        assert!(!form(&seen.lock().unwrap()[0]).contains_key("client_secret"));
    }

    #[test]
    fn exchange_without_refresh_token_fails() {
        let (url, _) = fake_token_server(vec![(200, r#"{"access_token":"AT"}"#)]);
        let err = block_on(exchange(
            Provider::Gdrive,
            &url,
            "C",
            "V",
            "http://127.0.0.1:9/",
        ))
        .unwrap_err();
        assert!(err.contains("didn't return a refresh token"), "{err}");
    }

    #[test]
    fn bearer_is_minted_once_then_cached() {
        let (url, seen) =
            fake_token_server(vec![(200, r#"{"access_token":"A1","expires_in":3599}"#)]);
        let cache = TokenCache::default();
        assert_eq!(
            *block_on(cache.bearer("k", Provider::Gdrive, &url, "RT")).unwrap(),
            "A1"
        );
        assert_eq!(
            *block_on(cache.bearer("k", Provider::Gdrive, &url, "RT")).unwrap(),
            "A1"
        );
        let f = form(&seen.lock().unwrap()[0]);
        assert_eq!(f["grant_type"], "refresh_token");
        assert_eq!(f["refresh_token"], "RT");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn evict_forces_a_fresh_mint() {
        let (url, seen) = fake_token_server(vec![
            (200, r#"{"access_token":"A1","expires_in":3599}"#),
            (200, r#"{"access_token":"A2","expires_in":3599}"#),
        ]);
        let cache = TokenCache::default();
        block_on(cache.bearer("k", Provider::Gdrive, &url, "RT")).unwrap();
        cache.evict("k");
        assert_eq!(
            *block_on(cache.bearer("k", Provider::Gdrive, &url, "RT")).unwrap(),
            "A2"
        );
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn revoked_refresh_token_asks_to_reconnect_and_is_not_cached() {
        let (url, seen) = fake_token_server(vec![
            (
                400,
                r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
            ),
            (400, r#"{"error":"invalid_grant"}"#),
        ]);
        let cache = TokenCache::default();
        let err = block_on(cache.bearer("k", Provider::Gdrive, &url, "RT")).unwrap_err();
        assert!(err.contains("Reconnect the account"), "{err}");
        assert!(block_on(cache.bearer("k", Provider::Gdrive, &url, "RT")).is_err());
        assert_eq!(seen.lock().unwrap().len(), 2);
    }
}
