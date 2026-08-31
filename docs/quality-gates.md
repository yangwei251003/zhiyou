# Quality gates

BossHunter Next handles personal evidence and user-authorized external actions. A green UI smoke
test is therefore insufficient. A release candidate must pass every gate below on a clean checkout.

## Automated gates

1. Strict TypeScript checks for every workspace package.
2. Type-aware ESLint with floating-promise and unsafe-async checks enabled.
3. Unit and integration tests for domain invariants, encryption, ingestion, AI protocol, resume
   provenance, connector authorization, renderer semantics, and Electron security policy.
4. Production builds for packages and the Electron main, preload, and renderer bundles.
5. Electron end-to-end journeys with console errors treated as failures.
6. `pnpm test:coverage` must execute successfully using the declared V8 coverage component for
   every workspace; CI runs this command rather than silently accepting a missing provider.
7. Security-critical filesystem helpers for exclusive resume export, atomic plaintext vault
   export, key-first vault deletion, and tombstone cleanup require direct unit tests in addition to
   UI journeys.
8. Persistent SQLite storage must retain foreign keys, WAL, and `synchronous=FULL`; resume document,
   version, claims, and artifact fault injection must prove all-or-nothing rollback and restart
   recovery.
9. On a trusted Windows release machine, `pnpm test:windows-trust` must report account and quota
   readability without generation, round-trip one JSONL record of at least 10 MiB through the exact
   broker data pump within five seconds with matching length and SHA-256, observe the
   PowerShell/Codex process tree, terminate its parent, and prove that no observed descendant
   survives.
10. Document parsers must run through the production utility-process bundle with no main-process
    fallback. Regression tests must cover lying DOCX declarations and relationship targets, bounded
    actual XML/RELS inflation, CRC/layout failures, aggregate extracted-text and fragment limits,
    parser timeout, fatal child failure, abnormal exit, single concurrency, termination poison, and
    successful Electron import through the built child entry.
11. `pnpm audit --audit-level high` must report no known high/critical dependency vulnerability.
    Electron must stay on a currently supported stable release line. Parser lifecycle regressions
    cover synchronous child exit and a fatal event following a provisional result; application
    lifecycle regressions prove that close is idempotent, drains accepted work, and rejects later
    work before it can open a dialog or child process.
12. `pnpm package:win` must produce the expected x64 portable ZIP and unpacked application.
    `pnpm test:packaged` must launch that executable with isolated user data, prove
    `app.isPackaged === true`, prove packaged builds ignore E2E environment hooks, render onboarding,
    and close cleanly. Every uploaded alpha archive must have a separately published SHA-256
    manifest and must be labelled unsigned/pre-release until a trusted signing pipeline exists.

CI actions are pinned to full commit SHAs. The Windows E2E job uploads its runner/build
fingerprints, screenshots, and report even after a failure, with a 14-day artifact retention period.

## Security release checks

- Renderer sandboxing, context isolation, navigation policy, main-frame IPC sender checks, packaged
  renderer URL lock, single-instance lock, and CSP remain enabled. Production `connect-src` must be
  `'none'`; development may name loopback HTTP/WebSocket sources only.
- Imported files are bounded, signature-checked, parsed as untrusted data, and never rendered as
  HTML. Import must compare bigint path/open-handle identity and `size`/`mtime`/`ctime` before read,
  then verify the open handle again after read; the documented Windows device-ID exception must
  retain the stable inode and all other comparisons.
- Codex runs are ephemeral, schema-constrained, read-only, and interrupted on any tool item or server
  approval request. On Windows, the native executable must have `Valid` Authenticode and exact
  signer `CN` and `O` values of `OpenAI OpCo, LLC`, including explicit paths, plus the pinned
  Microsoft Identity Verification root SHA-256; other systems must fail closed. The verifier path
  must originate in the kernel `SystemRoot` namespace rather than an environment variable. The
  fixed-volume path chain and target file stay locked across re-verification and process creation;
  reparse points, UNC, and ADS fail closed. Concurrent starts, cancellation during verification or
  initialization, pre-initialize peer exposure, Job cleanup, parent loss, permanent poison after an
  uncertain reap, and retry after ordinary failure require direct lifecycle or Windows crash-probe
  evidence.
- Resume exports fail closed if a claim lacks the current verified evidence revision or if wording
  different from its bound evidence has not received an exact-text, per-claim user attestation.
- Model-returned structured allowlists must never become trusted evidence. Regression tests must
  prove that hidden numbers, dates, employers, roles, certificates, skills, and qualitative outcomes
  cannot pass extraction, tailoring, draft validation, or export without visible user confirmation.
- Platform writes require a fresh one-time authorization bound to account, job, recipient, body, and
  attachment hashes. Unknown outcomes are reconciled before any retry.
- Persistent personal data is encrypted with a host-protected key; no plaintext fallback is allowed.
- Hosts without trustworthy key protection show an acknowledged memory-only mode only when no disk
  vault exists. An existing vault must be visibly locked, must not be shadowed by a new workspace,
  and must pass secure → unavailable/`basic_text` → export/delete → secure restart tests proving that
  export cannot omit hidden data and deletion cannot later resurrect it.
- E2E-only user-data, import-fixture, and simulated-AI hooks must remain unreachable in packaged
  builds.

## Human gates before a public release

- Keyboard-only and 200% zoom review on Windows.
- Screen-reader pass over onboarding, evidence review, job matrix, resume studio, and authorization
  review.
- Dependency-license and signed-installer review.
- Privacy, brand, Codex distribution, and recruitment-platform terms review listed in `LEGAL.md`.
- Native PDF/DOCX export, OCR, signed installation/update, signed-build hostile-parser testing, and the
  fact dispute/deletion/merge lifecycle must either be completed and retested or remain explicitly
  outside the public release scope. The private-alpha PowerShell/in-memory C# Codex broker must be
  replaced by a signed, reproducibly built native broker before public distribution.
