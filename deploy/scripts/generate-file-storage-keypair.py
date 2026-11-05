"""Generate one file-storage Ed25519 signing pair.

Both values use RFC 4648 base64url without padding, exactly as gears-rust
decodes them. Run once for each GitHub Environment; do not commit the output.
"""

from __future__ import annotations

import base64
import secrets

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
except ImportError as exc:
    raise SystemExit(
        "Missing dependency. Install it with: py -m pip install cryptography"
    ) from exc


def base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


seed = secrets.token_bytes(32)
key = Ed25519PrivateKey.from_private_bytes(seed)
public_key = key.public_key().public_bytes(
    serialization.Encoding.Raw,
    serialization.PublicFormat.Raw,
)

print(f"FILE_STORAGE_SIGNING_SEED={base64url(seed)}")
print(f"FILE_STORAGE_SIDECAR_PUBLIC_KEY={base64url(public_key)}")
