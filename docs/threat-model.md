# Threat model

## Highest-value assets

Personal documents, verified facts, contact details, recruitment sessions, Codex authentication,
outbound content, action authorizations, and encrypted backups.

## Mandatory controls

| Threat                                | Control                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Malicious or oversized document       | ZIP layout + bounded actual XML/RELS inflate/CRC; one-shot utility process, heap argument, watchdog, confirmed exit, no fallback     |
| Selected-file swap during import      | Bigint path/handle identity and metadata comparison before read, then handle `fstat` after read                                      |
| Prompt injection in resume/JD/message | Treat as untrusted data, no tool permissions, schema-only output                                                                     |
| HTML/XSS or tracking image            | Component renderer, escaping, CSP, no remote assets                                                                                  |
| Renderer compromise                   | Sandbox, context isolation, no Node, exact main-frame/webContents IPC validation, packaged URL lock, production `connect-src 'none'` |
| Work arriving during application exit | Remove IPC handlers, synchronous backend closing gate, drain accepted queue, idempotent teardown                                     |
| Credential leakage                    | OS credential store, allowlist logging, no credentials in renderer/database/backup                                                   |
| Codex executable substitution         | Kernel-SystemRoot broker, fixed-volume directory/file locks, file ID, `Valid` signature, exact CN/O, pinned Microsoft root           |
| Forged same-name user certificate     | Microsoft Identity Verification root SHA-256 pin; root rotation fails closed until an explicit product update                        |
| Concurrent Codex startup              | One in-flight startup, no pre-initialize peer, Job tree reaping; uncertain cleanup permanently poisons the runtime                   |
| Parent process crash                  | Raw control/stdio separation plus stdin-EOF `TerminateJobObject`; real Windows process-tree crash probe                              |
| Wrong target or changed draft         | Target/content hash authorization, short expiry, one-time nonce                                                                      |
| Network loss after click              | `outcome_unknown`, reconciliation, no automatic retry                                                                                |
| Platform DOM change                   | Versioned capability check, fail closed, kill switch                                                                                 |
| Malicious update                      | Signed installer, verified updates, and rollback remain public-release gates                                                         |
| Misplaced user export                 | Native plaintext warning, hidden staging, atomic publish, explicit partial-path error                                                |
| Concurrent app instances              | OS single-instance lock before vault initialization                                                                                  |
| Interrupted vault deletion            | Atomic directory isolation, key-first cryptographic erase, idempotent tombstone cleanup                                              |
| Test hook enabled in production       | E2E environment substitutions are conditioned on an unpackaged Electron runtime                                                      |

The alpha has no encrypted portable backup/restore. It must not claim protection for a feature that
does not yet exist.

Electron `safeStorage` availability alone is not considered sufficient on Linux: the `basic_text`
backend is classified as insecure, so the app uses an acknowledged, non-persistent memory workspace.

The alpha does not claim to resist malware that already controls the same Windows account and
integrity level, process injection, or an administrator. The Codex broker is defense in depth
against PATH impersonation, normal file races, forged user roots, and parent loss—not a replacement
for an OS privilege boundary. A signed, reproducibly built native broker remains a public-release
gate.

## Explicitly prohibited

Arbitrary JavaScript evaluation, arbitrary filesystem paths, cookie copying, browser fingerprint
evasion, CAPTCHA solving, unattended batch submissions, automatic Codex reset-credit use, and AI
access to external-action commands.
