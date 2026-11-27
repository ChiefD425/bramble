//! 2FA codes for the quick-access panel. The panel never holds a key, so its copy makes the code
//! here from the index, as it copies a password.
//!
//! Reads a stored key the way `@core`'s util/totp.ts does: an `otpauth://` URI read loosely
//! (#204), a Steam Guard key, or a bare base32 secret. The tests pin codes that file produced.
//! SHA-3 keys get no code here; nothing else in this process needs SHA-3.

use std::collections::HashMap;

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha224, Sha256, Sha384, Sha512};
use zeroize::Zeroizing;

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEAM_ALPHABET: &[u8; 26] = b"23456789BCDFGHJKMNPQRTVWXY";

/// A macro rather than a generic function: the bounds `Hmac<D>` needs name `digest` internals.
macro_rules! hmac {
    ($digest:ty, $key:expr, $message:expr) => {{
        let mut mac =
            <Hmac<$digest> as Mac>::new_from_slice($key).expect("HMAC takes a key of any length");
        mac.update($message);
        Zeroizing::new(mac.finalize().into_bytes().to_vec())
    }};
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Algorithm {
    Sha1,
    Sha224,
    Sha256,
    Sha384,
    Sha512,
}

pub struct Totp {
    secret: Zeroizing<Vec<u8>>,
    algorithm: Algorithm,
    digits: u32,
    period: u64,
    steam: bool,
}

impl Totp {
    /// None for anything that isn't a TOTP key: HOTP, migration blobs, a secret that isn't base32.
    pub fn parse(input: &str) -> Option<Self> {
        let raw = input.trim();
        if let Some(rest) = strip_prefix_ci(raw, "otpauth://") {
            return parse_otpauth(rest);
        }
        if let Some(rest) = strip_prefix_ci(raw, "steam://") {
            return Some(Self::steam(secret_from_base32(rest)?));
        }
        // RFC 6238 defaults for a bare secret.
        Some(Self {
            secret: secret_from_base32(raw)?,
            algorithm: Algorithm::Sha1,
            digits: 6,
            period: 30,
            steam: false,
        })
    }

    fn steam(secret: Zeroizing<Vec<u8>>) -> Self {
        // 10 digits is the whole 31-bit truncated value, which `code_at` re-encodes.
        Self {
            secret,
            algorithm: Algorithm::Sha1,
            digits: 10,
            period: 30,
            steam: true,
        }
    }

    /// The code for the time step holding `unix_secs`.
    pub fn code_at(&self, unix_secs: u64) -> String {
        let counter = (unix_secs / self.period).to_be_bytes();
        let digest = match self.algorithm {
            Algorithm::Sha1 => hmac!(Sha1, &self.secret, &counter),
            Algorithm::Sha224 => hmac!(Sha224, &self.secret, &counter),
            Algorithm::Sha256 => hmac!(Sha256, &self.secret, &counter),
            Algorithm::Sha384 => hmac!(Sha384, &self.secret, &counter),
            Algorithm::Sha512 => hmac!(Sha512, &self.secret, &counter),
        };
        let offset = (digest[digest.len() - 1] & 0x0f) as usize;
        let truncated = u32::from_be_bytes([
            digest[offset] & 0x7f,
            digest[offset + 1],
            digest[offset + 2],
            digest[offset + 3],
        ]);
        let mut n = u64::from(truncated) % 10u64.pow(self.digits);
        if !self.steam {
            return format!("{n:0width$}", width = self.digits as usize);
        }
        let mut code = String::with_capacity(5);
        for _ in 0..5 {
            code.push(STEAM_ALPHABET[(n % 26) as usize] as char);
            n /= 26;
        }
        code
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &s[prefix.len()..])
}

/// After `otpauth://`: `<kind>/<label>?<params>`. Parameter names are read case-insensitively,
/// and a later one wins, as `URLSearchParams` into a map does.
fn parse_otpauth(rest: &str) -> Option<Totp> {
    let rest = rest.split('#').next().unwrap_or_default();
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let kind = path
        .split('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut params = HashMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(
            form_decode(k).to_lowercase(),
            Zeroizing::new(form_decode(v)),
        );
    }
    let param = |name: &str| params.get(name).map(|v| v.as_str());

    let steam =
        kind == "steam" || param("encoder").is_some_and(|e| e.eq_ignore_ascii_case("steam"));
    if kind != "totp" && !steam {
        return None;
    }
    let secret = secret_from_base32(param("secret")?)?;
    if steam {
        return Some(Totp::steam(secret));
    }
    let period = whole_number(param("period"), 30).filter(|p| *p >= 1)?;
    // The dynamic truncation yields 31 bits, so more than 10 digits is meaningless.
    let digits = whole_number(param("digits"), 6).filter(|d| (1..=10).contains(d))?;
    let algorithm = algorithm(param("algorithm").unwrap_or("SHA1"))?;
    Some(Totp {
        secret,
        algorithm,
        digits: digits as u32,
        period,
        steam: false,
    })
}

/// JavaScript's `Number()` as far as a key needs it: `30.0` is 30, an empty value is 0, and
/// anything fractional or unreadable is refused.
fn whole_number(value: Option<&str>, default: u64) -> Option<u64> {
    let Some(value) = value else {
        return Some(default);
    };
    let value = value.trim();
    if value.is_empty() {
        return Some(0);
    }
    let n: f64 = value.parse().ok()?;
    (n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= u64::MAX as f64).then_some(n as u64)
}

/// The names the `otpauth` library accepts, canonicalized: `sha-256`, `SHA2-256` and `sha256`
/// are one algorithm.
fn algorithm(name: &str) -> Option<Algorithm> {
    let upper = name.to_ascii_uppercase();
    if matches!(upper.as_str(), "SHA1" | "SHA-1" | "SSL3-SHA1") {
        return Some(Algorithm::Sha1);
    }
    let bits = upper
        .strip_prefix("SHA2-")
        .or_else(|| upper.strip_prefix("SHA-"))
        .or_else(|| upper.strip_prefix("SHA"))?;
    match bits {
        "224" => Some(Algorithm::Sha224),
        "256" => Some(Algorithm::Sha256),
        "384" => Some(Algorithm::Sha384),
        "512" => Some(Algorithm::Sha512),
        _ => None,
    }
}

/// `application/x-www-form-urlencoded` decoding: `+` is a space, and a `%` that isn't followed by
/// two hex digits stays as it is.
fn form_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(hi), Some(lo)) => {
                    out.push(hi << 4 | lo);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// Spaces and dashes dropped, any case, `=` padding allowed at the end only.
fn secret_from_base32(value: &str) -> Option<Zeroizing<Vec<u8>>> {
    let clean = Zeroizing::new(
        value
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect::<String>()
            .to_uppercase(),
    );
    let data = clean.trim_end_matches('=');
    if data.is_empty() {
        return None;
    }
    let mut out = Zeroizing::new(Vec::with_capacity(data.len() * 5 / 8));
    let (mut bits, mut value) = (0u32, 0u32);
    for c in data.bytes() {
        let index = BASE32.iter().position(|&a| a == c)? as u32;
        value = (value << 5) | index;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((value >> bits) as u8);
            value &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA512_KEY: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";

    fn code(key: &str, at: u64) -> Option<String> {
        Totp::parse(key).map(|t| t.code_at(at))
    }

    // Produced by packages/core/src/util/totp.ts (parseTotp, then totpAt) at each of `TIMES`.
    #[test]
    fn matches_the_apps_own_codes() {
        const TIMES: [u64; 5] = [
            59,
            1_111_111_109,
            1_234_567_890,
            2_000_000_000,
            20_000_000_000,
        ];
        let cases: Vec<(String, [&str; 5])> = vec![
            ("JBSWY3DPEHPK3PXP".into(), ["996554", "071271", "742275", "890699", "752434"]),
            ("jbsw y3dp-ehpk 3pxp".into(), ["996554", "071271", "742275", "890699", "752434"]),
            ("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into(), ["287082", "081804", "005924", "279037", "353130"]),
            ("otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub".into(), ["996554", "071271", "742275", "890699", "752434"]),
            ("otpauth://totp/?secret=JBSW%20Y3DP%20EHPK%203PXP&period=30.0".into(), ["996554", "071271", "742275", "890699", "752434"]),
            (format!("otpauth://totp/X?secret={SHA512_KEY}&algorithm=sha-512&digits=8&period=60"), ["47562277", "64529471", "68546314", "76738871", "76050559"]),
            ("otpauth://totp/X?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&algorithm=SHA256&digits=8".into(), ["46119246", "68084774", "91819424", "90698825", "77737706"]),
            ("otpauth://totp/X?SECRET=JBSWY3DPEHPK3PXP&Algorithm=SHA2-384&digits=10".into(), ["1124302495", "0713639456", "1930228093", "1186539320", "0154098039"]),
            ("otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&algorithm=SHA224&digits=7".into(), ["5984076", "1274389", "8026864", "2714828", "4392996"]),
            ("otpauth://totp/Steam:me?secret=JBSWY3DPEHPK3PXP&encoder=steam".into(), ["2YXGV", "CWDGV", "K8G5W", "HNCVQ", "M9WG3"]),
            ("otpauth://steam/me?secret=JBSWY3DPEHPK3PXP".into(), ["2YXGV", "CWDGV", "K8G5W", "HNCVQ", "M9WG3"]),
            ("steam://JBSWY3DPEHPK3PXP".into(), ["2YXGV", "CWDGV", "K8G5W", "HNCVQ", "M9WG3"]),
            ("JBSWY3DPEHPK3PXP====".into(), ["996554", "071271", "742275", "890699", "752434"]),
        ];
        for (key, expected) in &cases {
            for (at, want) in TIMES.iter().zip(expected) {
                assert_eq!(code(key, *at).as_deref(), Some(*want), "{key} at {at}");
            }
        }
    }

    #[test]
    fn refuses_what_the_app_refuses() {
        for key in [
            "",
            "not base32!",
            "otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1",
            "otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&digits=11",
            "otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&period=0",
            "otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&period=",
            "otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&algorithm=MD5",
            "otpauth://totp/X?secret====",
            // A `?` inside the label leaves no `secret` parameter.
            "otpauth://totp/a?b?secret=JBSWY3DPEHPK3PXP",
        ] {
            assert!(Totp::parse(key).is_none(), "{key}");
        }
    }

    // The app makes codes for SHA-3 keys; the panel offers no copy for them rather than a wrong one.
    #[test]
    fn has_no_code_for_sha3() {
        assert!(
            Totp::parse("otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&algorithm=SHA3-256").is_none()
        );
    }
}
