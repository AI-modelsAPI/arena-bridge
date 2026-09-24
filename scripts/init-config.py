#!/usr/bin/env python3
"""Initialize a fresh, private .env without ever putting secrets in argv or Git."""
import argparse
import getpass
import hashlib
import json
import os
import re
import secrets
import sys
from pathlib import Path

DOMAIN = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$")
DEVICE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def make_env(host, names, password):
    host = host.strip().lower()
    if not DOMAIN.fullmatch(host):
        raise ValueError("enter a DNS hostname, without https:// or a path (for example bridge.example.com)")
    devices = [n.strip().lower() for n in names.split(",") if n.strip()]
    if not devices or len(devices) != len(set(devices)) or any(not DEVICE.fullmatch(n) or n in {"vps", "hub"} for n in devices):
        raise ValueError("devices must be unique comma-separated names like mac,android; vps/hub are reserved")
    if len(password) < 16:
        raise ValueError("unlock password must contain at least 16 characters")
    salt = secrets.token_bytes(32)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    hashed = f"scrypt${salt.hex()}${digest.hex()}"
    device_tokens = {name: secrets.token_hex(24) for name in devices}
    return (
        "# Generated locally by scripts/init-config.py; keep private and never commit.\n"
        f"BRIDGE_HOST={host}\n"
        f"BRIDGE_TOKEN={secrets.token_hex(24)}\n"
        "TZ=Asia/Shanghai\n"
        f"UNLOCK_PASSWORD_HASH='{hashed}'\n"
        f"DEVICE_TOKENS_JSON='{json.dumps(device_tokens, separators=(',', ':'))}'\n"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", help="public DNS name (prompted if omitted)")
    parser.add_argument("--devices", default="mac,android", help="comma-separated device names, default mac,android")
    parser.add_argument("--output", default=".env", help="path to new .env (must not exist)")
    parser.add_argument("--password-stdin", action="store_true", help="for tests/automation: read password from private stdin, never argv")
    opts = parser.parse_args()
    host = opts.host or input("Public domain for this hub (e.g. bridge.example.com): ")
    if opts.password_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        if not sys.stdin.isatty():
            parser.error("interactive password input needs a terminal; use --password-stdin with a private pipe")
        password = getpass.getpass("New unlock password (16+ chars): ")
        if password != getpass.getpass("Confirm unlock password: "):
            parser.error("passwords do not match")
    try:
        content = make_env(host, opts.devices, password)
        output = Path(opts.output)
        # Exclusive creation prevents accidentally overwriting a live or legacy .env.
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(content)
        except BaseException:
            output.unlink(missing_ok=True)
            raise
        print(f"Created {output} (0600) for {host}. Registered devices: {opts.devices}. Secrets were not printed.")
    except (OSError, ValueError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
