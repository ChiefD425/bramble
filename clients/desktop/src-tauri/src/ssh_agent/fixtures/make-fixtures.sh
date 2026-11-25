#!/usr/bin/env bash
# Writes the SSH agent's key fixtures into this folder. Re-run to regenerate; the tests read the
# files with include_str!, so the keys are throwaway and never used anywhere else.
set -euo pipefail
cd "$(dirname "$0")"
rm -f -- *.pub ed25519* ecdsa* rsa* dsa* sk-*

kg() { ssh-keygen -q -C fixture "$@"; }

kg -t ed25519 -N '' -f ed25519
kg -t ed25519 -N 'correct horse' -f ed25519-enc
# Past the agent's bcrypt-pbkdf limit (1024 rounds); slow to make, refused before any work.
kg -t ed25519 -a 2000 -N x -f ed25519-enc-2000
kg -t ecdsa -b 256 -N '' -f ecdsa256
kg -t ecdsa -b 384 -N '' -f ecdsa384
kg -t ecdsa -b 521 -N '' -f ecdsa521
kg -t rsa -b 2048 -N '' -f rsa2048
kg -t rsa -b 2048 -N 'correct horse' -f rsa2048-enc

# The PEM flavours a user may paste, and what a CXF import stores (PKCS#8).
openssl genrsa -traditional -out rsa-pkcs1 2048 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out ecdsa-sec1
openssl genpkey -algorithm ed25519 -out ed25519-pkcs8
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out rsa-pkcs8 2>/dev/null
openssl ecparam -name secp384r1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out ecdsa384-pkcs8
chmod 600 rsa-pkcs1 ecdsa-sec1 ed25519-pkcs8 rsa-pkcs8 ecdsa384-pkcs8
for f in rsa-pkcs1 ecdsa-sec1 ed25519-pkcs8 rsa-pkcs8 ecdsa384-pkcs8; do
	ssh-keygen -y -f "$f" > "$f.pub"
done

# Refused kinds.
openssl genrsa -traditional -aes128 -passout pass:x -out rsa-legacy-enc 2048 2>/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -aes256 -pass pass:x -out rsa-pkcs8-enc 2>/dev/null
printf -- '-----BEGIN DSA PRIVATE KEY-----\nMIIBuwIBAAKBgQD\n-----END DSA PRIVATE KEY-----\n' > dsa
python3 - <<'PY'
import base64, os, struct

def string(b):
    return struct.pack(">I", len(b)) + b

# A hardware security key's OpenSSH container: the private half stays on the key, only a handle
# is stored. Built by hand because making one needs the hardware.
pk = os.urandom(32)
app = b"ssh:"
kind = b"sk-ssh-ed25519@openssh.com"
public = string(kind) + string(pk) + string(app)
check = os.urandom(4)
private = check + check + string(kind) + string(pk) + string(app) + b"\x01" + string(os.urandom(64)) + string(b"") + string(b"fixture")
pad = 1
while len(private) % 8:
    private += bytes([pad])
    pad += 1
blob = b"openssh-key-v1\x00" + string(b"none") + string(b"none") + string(b"") + struct.pack(">I", 1) + string(public) + string(private)
b64 = base64.b64encode(blob).decode()
lines = [b64[i:i + 70] for i in range(0, len(b64), 70)]
open("sk-ed25519", "w").write("-----BEGIN OPENSSH PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END OPENSSH PRIVATE KEY-----\n")

# A PKCS#1 RSA key with a 9000-bit modulus, past the agent's 8192-bit limit. Only its shape is
# real: the limit is checked before the numbers are used.
def der_int(n):
    b = n.to_bytes((n.bit_length() + 8) // 8 or 1, "big")
    return b"\x02" + der_len(len(b)) + b

def der_len(n):
    if n < 128:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b

n = int.from_bytes(os.urandom(1125), "big") | (1 << 8999) | 1
ints = [0, n, 65537, n - 2, 3, 5, 7, 11, 13]
body = b"".join(der_int(i) for i in ints)
der = b"\x30" + der_len(len(body)) + body
b64 = base64.b64encode(der).decode()
lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
open("rsa-too-big", "w").write("-----BEGIN RSA PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END RSA PRIVATE KEY-----\n")
PY
echo done
