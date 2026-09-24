# Security model and remaining limits

This bridge deliberately grants an authenticated AI client very powerful access to the owner's machines. **The main Bridge token is equivalent to a remote-control credential.** Never expose it to public repos, third-party logs, untrusted agents or URL query strings. Keep separate device tokens and rotate any compromised secret.

## Boundaries in v0.3

- Locked: no arbitrary shell, process sessions, recursive deletes, content search, credential reads or third-party MCP tools. Ordinary file operations are limited to configured directories and symlink-resolved paths. The unlock password is held as a salted scrypt hash, not plaintext in the container environment.
- Unlocked: unrestricted operations for the configured time. **Previously launched processes can continue after relocking.** The policy is an accidental-action guard, not an adversarial sandbox. A user authorized to write inside a workspace might still create scripts that run later via another mechanism.
- The hub runs as a non-root Docker user by default. Strong isolation requires separate OS accounts/containers, restrictive mounts, network controls and deployment-level access policy. Do not mount the host Docker socket.
- Symlink canonicalization is not atomic against a local adversary changing links between validation and opening a path (TOCTOU). Enforce hard confinement with OS primitives such as a restricted container filesystem or directory-fd/openat-style operations. A filename regex cannot identify all secrets; keep credentials outside exposed mounts and allowed directories.
- Single upload/download operations are limited (about 8 MiB per binary file). There is **no streaming/chunked upload** or per-token rate limiting yet; add these before use with large files or untrusted callers. Set reverse-proxy and Docker resource limits.
- Device tokens in the `Sec-WebSocket-Protocol` header are not placed in URLs, but reverse proxies that record headers may still log them. Configure proxy log redaction and rotate on suspected exposure.
- The default audit log contains metadata only and is mode 0600. `AUDIT_LOG=off` disables it explicitly. A malicious process running during an unlock may modify local audit data if it has filesystem rights; forward logs to a separate, append-only service for tamper resistance.
- No security assessment can establish that a third-party AI will respect ownership claims in a prompt. Only grant access to devices and directories you trust it to operate. Avoid sharing the unlock password in AI chats when a manual local unlock is possible.

## Reporting and testing

Please report suspected security issues privately to the repository owner rather than posting access tokens or exploit output in an issue. Run `npm ci && npm test` and `npm audit --omit=dev` in CI. The automated tests use isolated temporary files and a localhost-only hub/device, never a real connected machine.
