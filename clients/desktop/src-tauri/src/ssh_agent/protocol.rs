//! The SSH agent protocol (draft-miller-ssh-agent), the part OpenSSH's clients speak.
//!
//! Frames are a big-endian u32 length and then a message: one type byte and its fields. Only
//! listing, signing and OpenSSH's `session-bind@openssh.com` extension are understood; everything
//! else (adding or removing keys, the agent's own lock) answers with a failure, because the vault
//! is the only source of keys.

use std::io::{self, Read, Write};

use serde::Serialize;
use ssh_encoding::{Decode, Encode};

/// Nothing a client sends comes near this; a larger frame is a bug or an attempt to exhaust
/// memory.
pub const MAX_FRAME: u32 = 256 * 1024;

const FAILURE: u8 = 5;
const SUCCESS: u8 = 6;
const REQUEST_IDENTITIES: u8 = 11;
const IDENTITIES_ANSWER: u8 = 12;
const SIGN_REQUEST: u8 = 13;
const SIGN_RESPONSE: u8 = 14;
const EXTENSION: u8 = 27;
const SESSION_BIND: &str = "session-bind@openssh.com";

pub enum Request {
    Identities,
    Sign {
        key: Vec<u8>,
        data: Vec<u8>,
        flags: u32,
    },
    /// OpenSSH 8.9+ binds each agent connection to the server it is for, and says whether the
    /// connection was forwarded to that server.
    SessionBind {
        host_key: Vec<u8>,
        forwarding: bool,
    },
    Unsupported,
}

pub enum Reply {
    Identities(Vec<(Vec<u8>, String)>),
    Signature(Vec<u8>),
    Success,
    Failure,
}

/// What a signature is for, read from the data to sign, for the line the user sees.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Purpose {
    SignIn,
    Git,
    Message,
}

/// The next request, or `None` when the client closed the connection between frames.
pub fn read_request(r: &mut impl Read) -> io::Result<Option<Request>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len);
    if len == 0 || len > MAX_FRAME {
        return Err(invalid("frame length"));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    let (kind, mut fields) = (body[0], &body[1..]);
    let request = match kind {
        REQUEST_IDENTITIES => Request::Identities,
        SIGN_REQUEST => Request::Sign {
            key: Vec::<u8>::decode(&mut fields).map_err(malformed)?,
            data: Vec::<u8>::decode(&mut fields).map_err(malformed)?,
            flags: u32::decode(&mut fields).map_err(malformed)?,
        },
        EXTENSION => {
            let name = String::decode(&mut fields).map_err(malformed)?;
            if name != SESSION_BIND {
                return Ok(Some(Request::Unsupported));
            }
            let host_key = Vec::<u8>::decode(&mut fields).map_err(malformed)?;
            let _session_id = Vec::<u8>::decode(&mut fields).map_err(malformed)?;
            let _signature = Vec::<u8>::decode(&mut fields).map_err(malformed)?;
            let forwarding = u8::decode(&mut fields).map_err(malformed)? != 0;
            Request::SessionBind {
                host_key,
                forwarding,
            }
        }
        _ => Request::Unsupported,
    };
    Ok(Some(request))
}

pub fn write_reply(w: &mut impl Write, reply: &Reply) -> io::Result<()> {
    let mut body = Vec::new();
    let encoded = match reply {
        Reply::Failure => FAILURE.encode(&mut body),
        Reply::Success => SUCCESS.encode(&mut body),
        Reply::Signature(sig) => SIGN_RESPONSE
            .encode(&mut body)
            .and_then(|()| sig.encode(&mut body)),
        Reply::Identities(keys) => IDENTITIES_ANSWER
            .encode(&mut body)
            .and_then(|()| (keys.len() as u32).encode(&mut body))
            .and_then(|()| {
                keys.iter().try_for_each(|(blob, comment)| {
                    blob.encode(&mut body)?;
                    comment.encode(&mut body)
                })
            }),
    };
    encoded.map_err(malformed)?;
    w.write_all(&(body.len() as u32).to_be_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

/// An SSHSIG request (`ssh-keygen -Y sign`, which git commit signing uses) carries its namespace;
/// anything else is a sign-in's session data.
pub fn purpose(data: &[u8]) -> Purpose {
    let Some(mut rest) = data.strip_prefix(b"SSHSIG") else {
        return Purpose::SignIn;
    };
    match Vec::<u8>::decode(&mut rest) {
        Ok(ns) if ns == b"git" => Purpose::Git,
        _ => Purpose::Message,
    }
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("ssh agent: bad {what}"))
}

fn malformed(_: ssh_encoding::Error) -> io::Error {
    invalid("message")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string(b: &[u8]) -> Vec<u8> {
        let mut out = (b.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(b);
        out
    }

    fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
        out.push(kind);
        out.extend_from_slice(payload);
        out
    }

    fn read(bytes: &[u8]) -> io::Result<Option<Request>> {
        read_request(&mut &bytes[..])
    }

    #[test]
    fn reads_identities_and_sign_requests() {
        assert!(matches!(
            read(&frame(11, &[])),
            Ok(Some(Request::Identities))
        ));
        let payload = [string(b"KEY"), string(b"DATA"), 2u32.to_be_bytes().to_vec()].concat();
        match read(&frame(13, &payload)).unwrap() {
            Some(Request::Sign { key, data, flags }) => {
                assert_eq!((key, data, flags), (b"KEY".to_vec(), b"DATA".to_vec(), 2));
            }
            _ => panic!("not a sign request"),
        }
    }

    #[test]
    fn session_bind_reads_host_key_and_forwarding() {
        for forwarding in [true, false] {
            let payload = [
                string(b"session-bind@openssh.com"),
                string(b"HOSTKEY"),
                string(b"SESSION"),
                string(b"SIG"),
                vec![forwarding as u8],
            ]
            .concat();
            match read(&frame(27, &payload)).unwrap() {
                Some(Request::SessionBind {
                    host_key,
                    forwarding: f,
                }) => {
                    assert_eq!((host_key, f), (b"HOSTKEY".to_vec(), forwarding));
                }
                _ => panic!("not a session bind"),
            }
        }
    }

    #[test]
    fn other_messages_are_unsupported() {
        for kind in [17u8, 18, 22, 25] {
            assert!(matches!(
                read(&frame(kind, b"xx")),
                Ok(Some(Request::Unsupported))
            ));
        }
        let query = string(b"query");
        assert!(matches!(
            read(&frame(27, &query)),
            Ok(Some(Request::Unsupported))
        ));
    }

    #[test]
    fn oversized_frame_is_an_error() {
        let mut bytes = (MAX_FRAME + 1).to_be_bytes().to_vec();
        bytes.push(11);
        assert!(read(&bytes).is_err());
    }

    #[test]
    fn truncated_or_malformed_frames_are_errors() {
        assert!(read(&[0, 0, 0, 5, 13]).is_err());
        assert!(read(&frame(13, &string(b"KEY"))).is_err());
        assert!(read(&[0, 0, 0, 0]).is_err());
    }

    #[test]
    fn eof_between_frames_is_none() {
        assert!(matches!(read(&[]), Ok(None)));
    }

    #[test]
    fn replies_encode_as_openssh_expects() {
        let mut out = Vec::new();
        write_reply(&mut out, &Reply::Failure).unwrap();
        assert_eq!(out, [0, 0, 0, 1, 5]);

        let mut out = Vec::new();
        write_reply(&mut out, &Reply::Success).unwrap();
        assert_eq!(out, [0, 0, 0, 1, 6]);

        let mut out = Vec::new();
        let keys = vec![(b"BLOB".to_vec(), "GitHub".to_string())];
        write_reply(&mut out, &Reply::Identities(keys)).unwrap();
        let body = [
            vec![12],
            1u32.to_be_bytes().to_vec(),
            string(b"BLOB"),
            string(b"GitHub"),
        ]
        .concat();
        assert_eq!(
            out,
            [(body.len() as u32).to_be_bytes().to_vec(), body].concat()
        );

        let mut out = Vec::new();
        write_reply(&mut out, &Reply::Signature(b"SIG".to_vec())).unwrap();
        let body = [vec![14], string(b"SIG")].concat();
        assert_eq!(
            out,
            [(body.len() as u32).to_be_bytes().to_vec(), body].concat()
        );
    }

    #[test]
    fn purpose_reads_sshsig_namespace() {
        let sshsig = |ns: &[u8]| {
            [
                b"SSHSIG".to_vec(),
                string(ns),
                string(b""),
                string(b"sha512"),
                string(b"H"),
            ]
            .concat()
        };
        assert!(matches!(purpose(&sshsig(b"git")), Purpose::Git));
        assert!(matches!(purpose(&sshsig(b"file")), Purpose::Message));
        assert!(matches!(
            purpose(b"\x00\x00\x00\x20random session id and more"),
            Purpose::SignIn
        ));
    }
}
