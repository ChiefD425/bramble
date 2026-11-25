//! Reading an SSH private key as the vault stores it, and signing with it.
//!
//! The vault keeps whatever PEM the user pasted or an import wrote: the OpenSSH container
//! (possibly encrypted with the entry's passphrase), PKCS#1, SEC1 or PKCS#8. Everything here is
//! pure: no I/O, no global state. A key that can't be used says why, for the Settings list.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rsa::{
    pkcs1::der::Decode as _,
    signature::{SignatureEncoding, Signer as _},
    BoxedUint,
};
use serde::Serialize;
use ssh_encoding::Encode;
use ssh_key::{
    private::{EcdsaKeypair, EcdsaPrivateKey, Ed25519Keypair, KeypairData},
    public::{KeyData, RsaPublicKey},
    Algorithm, HashAlg, Kdf, Mpint, PrivateKey, Signature,
};

/// Why a stored key can't be used by the agent. Shown in Settings with the fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Unusable {
    /// The old OpenSSL-encrypted PEM (`Proc-Type: 4,ENCRYPTED`) or encrypted PKCS#8.
    EncryptedPem,
    /// A hardware security-key type: the private half is on the key, not in the vault.
    SecurityKey,
    Dsa,
    WrongPassphrase,
    /// Past the limits a hostile entry could use to stall the app.
    Unsupported,
    Unreadable,
}

#[derive(Debug)]
pub enum SignError {
    /// An RSA request without the SHA-2 flags asks for a SHA-1 `ssh-rsa` signature.
    Sha1Refused,
    Failed,
}

/// `SSH_AGENT_RSA_SHA2_256` and `SSH_AGENT_RSA_SHA2_512` in a sign request's flags.
pub const RSA_SHA2_256: u32 = 0x02;
pub const RSA_SHA2_512: u32 = 0x04;

/// More rounds than this and opening the key takes long enough to stall the app; OpenSSH writes
/// 16 by default and `ssh-keygen -a 100` is the common hardening.
const MAX_BCRYPT_ROUNDS: u32 = 1024;
/// 8192 bits, as bytes of modulus.
const MAX_RSA_MODULUS_BYTES: usize = 8192 / 8;

/// A key ready to sign. Its secrets zeroize when it drops.
pub struct AgentKey {
    public: Vec<u8>,
    kind: Kind,
}

enum Kind {
    /// ed25519 and ECDSA, which ssh-key signs itself.
    Ssh(PrivateKey),
    /// RSA through the `rsa` crate directly; ssh-key's own RSA would pin rsa 0.9.
    Rsa(Box<rsa::PrivateKey>),
}

/// Read a stored private key. `passphrase` opens an encrypted OpenSSH container.
pub fn parse(pem: &str, passphrase: Option<&str>) -> Result<AgentKey, Unusable> {
    let label = pem_label(pem).ok_or(Unusable::Unreadable)?;
    let encrypted_pem = pem.contains("Proc-Type: 4,ENCRYPTED");
    match label {
        "OPENSSH PRIVATE KEY" => parse_openssh(pem, passphrase),
        "ENCRYPTED PRIVATE KEY" => Err(Unusable::EncryptedPem),
        _ if encrypted_pem => Err(Unusable::EncryptedPem),
        "DSA PRIVATE KEY" => Err(Unusable::Dsa),
        "RSA PRIVATE KEY" => parse_pkcs1(&pem_der(pem)?),
        "EC PRIVATE KEY" => parse_sec1(&pem_der(pem)?),
        "PRIVATE KEY" => parse_pkcs8(&pem_der(pem)?),
        _ => Err(Unusable::Unreadable),
    }
}

impl AgentKey {
    /// The SSH wire public key: what `ssh-add -L` prints in base64.
    pub fn public_blob(&self) -> &[u8] {
        &self.public
    }

    /// Sign `data`, answering with the wire signature (algorithm name and signature bytes).
    pub fn sign(&self, data: &[u8], flags: u32) -> Result<Vec<u8>, SignError> {
        let signature = match &self.kind {
            Kind::Ssh(key) => signature::Signer::<Signature>::try_sign(key, data)
                .map_err(|_| SignError::Failed)?,
            Kind::Rsa(key) => {
                let (hash, bytes) = if flags & RSA_SHA2_512 != 0 {
                    let signer =
                        rsa::pkcs1v15::SigningKey::<rsa::sha2::Sha512>::new((**key).clone());
                    let sig = signer.try_sign(data).map_err(|_| SignError::Failed)?;
                    (HashAlg::Sha512, sig.to_vec())
                } else if flags & RSA_SHA2_256 != 0 {
                    let signer =
                        rsa::pkcs1v15::SigningKey::<rsa::sha2::Sha256>::new((**key).clone());
                    let sig = signer.try_sign(data).map_err(|_| SignError::Failed)?;
                    (HashAlg::Sha256, sig.to_vec())
                } else {
                    return Err(SignError::Sha1Refused);
                };
                Signature::new(Algorithm::Rsa { hash: Some(hash) }, bytes)
                    .map_err(|_| SignError::Failed)?
            }
        };
        wire(&signature).map_err(|_| SignError::Failed)
    }

    #[cfg(test)]
    pub(crate) fn rsa_for_tests(&self) -> Option<&rsa::PrivateKey> {
        match &self.kind {
            Kind::Rsa(key) => Some(key),
            Kind::Ssh(_) => None,
        }
    }
}

fn parse_openssh(pem: &str, passphrase: Option<&str>) -> Result<AgentKey, Unusable> {
    let key = PrivateKey::from_openssh(pem.trim()).map_err(|_| Unusable::Unreadable)?;
    match key.algorithm() {
        Algorithm::SkEd25519 | Algorithm::SkEcdsaSha2NistP256 => return Err(Unusable::SecurityKey),
        Algorithm::Dsa => return Err(Unusable::Dsa),
        _ => {}
    }
    let key = if key.is_encrypted() {
        // Checked before decrypting: the rounds are the whole cost.
        if let Kdf::Bcrypt { rounds, .. } = key.kdf() {
            if *rounds > MAX_BCRYPT_ROUNDS {
                return Err(Unusable::Unsupported);
            }
        }
        let passphrase = passphrase.ok_or(Unusable::WrongPassphrase)?;
        key.decrypt(passphrase)
            .map_err(|_| Unusable::WrongPassphrase)?
    } else {
        key
    };
    let public = wire(key.public_key().key_data()).map_err(|_| Unusable::Unreadable)?;
    match key.key_data() {
        KeypairData::Ed25519(_) | KeypairData::Ecdsa(_) => Ok(AgentKey {
            public,
            kind: Kind::Ssh(key),
        }),
        KeypairData::Rsa(rsa) => rsa_key(
            part(&rsa.public.n)?,
            part(&rsa.public.e)?,
            part(&rsa.private.d)?,
            part(&rsa.private.p)?,
            part(&rsa.private.q)?,
        ),
        _ => Err(Unusable::Unreadable),
    }
}

fn part(m: &Mpint) -> Result<&[u8], Unusable> {
    m.as_positive_bytes().ok_or(Unusable::Unreadable)
}

fn parse_pkcs1(der: &[u8]) -> Result<AgentKey, Unusable> {
    let key = rsa::pkcs1::RsaPrivateKeyRef::from_der(der).map_err(|_| Unusable::Unreadable)?;
    rsa_key(
        key.modulus.as_bytes(),
        key.public_exponent.as_bytes(),
        key.private_exponent.as_bytes(),
        key.prime1.as_bytes(),
        key.prime2.as_bytes(),
    )
}

fn parse_sec1(der: &[u8]) -> Result<AgentKey, Unusable> {
    if let Ok(secret) = p256::SecretKey::from_sec1_der(der) {
        return ecdsa_key(EcdsaKeypair::NistP256 {
            public: secret.public_key().to_encoded_point(false),
            private: EcdsaPrivateKey::from(secret),
        });
    }
    if let Ok(secret) = p384::SecretKey::from_sec1_der(der) {
        return ecdsa_key(EcdsaKeypair::NistP384 {
            public: secret.public_key().to_encoded_point(false),
            private: EcdsaPrivateKey::from(secret),
        });
    }
    if let Ok(secret) = p521::SecretKey::from_sec1_der(der) {
        return ecdsa_key(EcdsaKeypair::NistP521 {
            public: secret.public_key().to_encoded_point(false),
            private: EcdsaPrivateKey::from(secret),
        });
    }
    Err(Unusable::Unreadable)
}

fn parse_pkcs8(der: &[u8]) -> Result<AgentKey, Unusable> {
    // One trait for all four: ed25519-dalek and the p-curves share pkcs8 0.10.
    use ed25519_dalek::pkcs8::DecodePrivateKey as _;
    if let Ok(signing) = ed25519_dalek::SigningKey::from_pkcs8_der(der) {
        let keypair = Ed25519Keypair::from_seed(&signing.to_bytes());
        return ssh_key_from(KeypairData::Ed25519(keypair));
    }
    if let Ok(secret) = p256::SecretKey::from_pkcs8_der(der) {
        return ecdsa_key(EcdsaKeypair::NistP256 {
            public: secret.public_key().to_encoded_point(false),
            private: EcdsaPrivateKey::from(secret),
        });
    }
    if let Ok(secret) = p384::SecretKey::from_pkcs8_der(der) {
        return ecdsa_key(EcdsaKeypair::NistP384 {
            public: secret.public_key().to_encoded_point(false),
            private: EcdsaPrivateKey::from(secret),
        });
    }
    if let Ok(secret) = p521::SecretKey::from_pkcs8_der(der) {
        return ecdsa_key(EcdsaKeypair::NistP521 {
            public: secret.public_key().to_encoded_point(false),
            private: EcdsaPrivateKey::from(secret),
        });
    }
    let info = rsa::pkcs8::PrivateKeyInfoRef::from_der(der).map_err(|_| Unusable::Unreadable)?;
    parse_pkcs1(info.private_key.as_bytes())
}

fn ecdsa_key(keypair: EcdsaKeypair) -> Result<AgentKey, Unusable> {
    ssh_key_from(KeypairData::Ecdsa(keypair))
}

fn ssh_key_from(data: KeypairData) -> Result<AgentKey, Unusable> {
    let key = PrivateKey::new(data, "").map_err(|_| Unusable::Unreadable)?;
    let public = wire(key.public_key().key_data()).map_err(|_| Unusable::Unreadable)?;
    Ok(AgentKey {
        public,
        kind: Kind::Ssh(key),
    })
}

/// An RSA key from its big-endian parts, whatever container they came from. The size limit is
/// checked on the modulus before any arithmetic.
fn rsa_key(n: &[u8], e: &[u8], d: &[u8], p: &[u8], q: &[u8]) -> Result<AgentKey, Unusable> {
    let n = trim_zeros(n);
    if n.len() > MAX_RSA_MODULUS_BYTES {
        return Err(Unusable::Unsupported);
    }
    let bits = u32::try_from(n.len() * 8).map_err(|_| Unusable::Unreadable)?;
    let uint = |bytes: &[u8], bits: u32| {
        BoxedUint::from_be_slice(trim_zeros(bytes), bits).map_err(|_| Unusable::Unreadable)
    };
    let e_bytes = trim_zeros(e);
    let e_bits = u32::try_from(e_bytes.len().max(1) * 8).map_err(|_| Unusable::Unreadable)?;
    let key = rsa::PrivateKey::from_components(
        uint(n, bits)?,
        uint(e_bytes, e_bits)?,
        uint(d, bits)?,
        vec![uint(p, bits)?, uint(q, bits)?],
    )
    .map_err(|_| Unusable::Unreadable)?;
    let public = wire(&KeyData::Rsa(RsaPublicKey {
        e: Mpint::from_positive_bytes(e_bytes).map_err(|_| Unusable::Unreadable)?,
        n: Mpint::from_positive_bytes(n).map_err(|_| Unusable::Unreadable)?,
    }))
    .map_err(|_| Unusable::Unreadable)?;
    Ok(AgentKey {
        public,
        kind: Kind::Rsa(Box::new(key)),
    })
}

/// A value in SSH wire encoding.
fn wire(value: &impl Encode) -> Result<Vec<u8>, ssh_encoding::Error> {
    let mut out = Vec::with_capacity(value.encoded_len()?);
    value.encode(&mut out)?;
    Ok(out)
}

fn trim_zeros(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    &bytes[start..]
}

/// The label of the first `-----BEGIN <label>-----` line.
fn pem_label(pem: &str) -> Option<&str> {
    let start = pem.find("-----BEGIN ")? + "-----BEGIN ".len();
    let end = pem[start..].find("-----")?;
    Some(&pem[start..start + end])
}

/// The DER between the armor lines, skipping RFC 1421 headers.
fn pem_der(pem: &str) -> Result<Vec<u8>, Unusable> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .skip_while(|l| !l.starts_with("-----BEGIN "))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END "))
        .filter(|l| !l.contains(':'))
        .collect();
    B64.decode(body).map_err(|_| Unusable::Unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use ssh_encoding::Decode;
    use std::time::{Duration, Instant};

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("fixtures/", $name))
        };
    }

    /// The base64 middle field of a `.pub` line: the SSH wire public key.
    fn wire(pub_line: &str) -> Vec<u8> {
        B64.decode(pub_line.split_whitespace().nth(1).unwrap())
            .unwrap()
    }

    const SUPPORTED: &[(&str, &str, &str, Option<&str>)] = &[
        (
            "ed25519",
            fixture!("ed25519"),
            fixture!("ed25519.pub"),
            None,
        ),
        (
            "ed25519-enc",
            fixture!("ed25519-enc"),
            fixture!("ed25519-enc.pub"),
            Some("correct horse"),
        ),
        (
            "ecdsa256",
            fixture!("ecdsa256"),
            fixture!("ecdsa256.pub"),
            None,
        ),
        (
            "ecdsa384",
            fixture!("ecdsa384"),
            fixture!("ecdsa384.pub"),
            None,
        ),
        (
            "ecdsa521",
            fixture!("ecdsa521"),
            fixture!("ecdsa521.pub"),
            None,
        ),
        (
            "rsa2048",
            fixture!("rsa2048"),
            fixture!("rsa2048.pub"),
            None,
        ),
        (
            "rsa2048-enc",
            fixture!("rsa2048-enc"),
            fixture!("rsa2048-enc.pub"),
            Some("correct horse"),
        ),
        (
            "rsa-pkcs1",
            fixture!("rsa-pkcs1"),
            fixture!("rsa-pkcs1.pub"),
            None,
        ),
        (
            "ecdsa-sec1",
            fixture!("ecdsa-sec1"),
            fixture!("ecdsa-sec1.pub"),
            None,
        ),
        (
            "ed25519-pkcs8",
            fixture!("ed25519-pkcs8"),
            fixture!("ed25519-pkcs8.pub"),
            None,
        ),
        (
            "ecdsa384-pkcs8",
            fixture!("ecdsa384-pkcs8"),
            fixture!("ecdsa384-pkcs8.pub"),
            None,
        ),
        (
            "rsa-pkcs8",
            fixture!("rsa-pkcs8"),
            fixture!("rsa-pkcs8.pub"),
            None,
        ),
    ];

    #[test]
    fn every_supported_format_parses_and_matches_its_pub() {
        for (name, pem, pub_line, pass) in SUPPORTED {
            let key = parse(pem, *pass).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(key.public_blob(), wire(pub_line), "{name}");
        }
    }

    #[test]
    fn signatures_verify() {
        let data = b"session id and userauth request";
        for (name, pem, pub_line, pass) in SUPPORTED {
            let key = parse(pem, *pass).unwrap();
            let rsa = pub_line.starts_with("ssh-rsa");
            let flags = if rsa { RSA_SHA2_256 } else { 0 };
            let blob = key
                .sign(data, flags)
                .unwrap_or_else(|_| panic!("{name}: sign"));
            let sig = ssh_key::Signature::decode(&mut &blob[..]).unwrap();
            if rsa {
                use rsa::signature::Verifier;
                let public = key.rsa_for_tests().unwrap().to_public_key();
                let verifier = rsa::pkcs1v15::VerifyingKey::<rsa::sha2::Sha256>::new(public);
                let parsed = rsa::pkcs1v15::Signature::try_from(sig.as_bytes()).unwrap();
                verifier
                    .verify(data, &parsed)
                    .unwrap_or_else(|_| panic!("{name}: verify"));
            } else {
                use signature::Verifier;
                let public = ssh_key::PublicKey::from_openssh(pub_line).unwrap();
                // KeyData, not PublicKey: PublicKey's own `verify` is the SSHSIG one.
                public
                    .key_data()
                    .verify(data, &sig)
                    .unwrap_or_else(|_| panic!("{name}: verify"));
            }
        }
    }

    #[test]
    fn encrypted_openssh_opens_with_its_passphrase() {
        assert!(parse(fixture!("ed25519-enc"), Some("correct horse")).is_ok());
    }

    #[test]
    fn wrong_or_missing_passphrase_is_wrong_passphrase() {
        for pass in [Some("nope"), None] {
            assert_eq!(
                parse(fixture!("ed25519-enc"), pass).err(),
                Some(Unusable::WrongPassphrase)
            );
        }
    }

    #[test]
    fn refused_kinds_say_why() {
        assert_eq!(
            parse(fixture!("rsa-legacy-enc"), Some("x")).err(),
            Some(Unusable::EncryptedPem)
        );
        assert_eq!(
            parse(fixture!("rsa-pkcs8-enc"), Some("x")).err(),
            Some(Unusable::EncryptedPem)
        );
        assert_eq!(
            parse(fixture!("sk-ed25519"), None).err(),
            Some(Unusable::SecurityKey)
        );
        assert_eq!(parse(fixture!("dsa"), None).err(), Some(Unusable::Dsa));
        assert_eq!(parse("hello", None).err(), Some(Unusable::Unreadable));
    }

    #[test]
    fn past_the_limits_is_unsupported() {
        let started = Instant::now();
        assert_eq!(
            parse(fixture!("ed25519-enc-2000"), Some("x")).err(),
            Some(Unusable::Unsupported)
        );
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "refused before any KDF work"
        );
        assert_eq!(
            parse(fixture!("rsa-too-big"), None).err(),
            Some(Unusable::Unsupported)
        );
    }

    #[test]
    fn rsa_without_sha2_flags_is_refused() {
        let key = parse(fixture!("rsa2048"), None).unwrap();
        assert!(matches!(key.sign(b"x", 0), Err(SignError::Sha1Refused)));
        for (flags, algo) in [
            (RSA_SHA2_256, "rsa-sha2-256"),
            (RSA_SHA2_512, "rsa-sha2-512"),
        ] {
            let blob = key.sign(b"x", flags).unwrap();
            let sig = ssh_key::Signature::decode(&mut &blob[..]).unwrap();
            assert_eq!(sig.algorithm().as_str(), algo);
        }
    }
}
