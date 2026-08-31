# Architecture

## Current private-alpha process boundaries

```text
Sandboxed React renderer
          |
          | narrow preload API + schema-validated IPC
          v
Electron main process
  |              |                         |
  v              v                         v
single SQLite    parser utility process    Codex App Server
writer           (one-shot/local only)     (ephemeral/read-only)
```

- The renderer has no Node, filesystem, database, cookie, credential, process, or shell access.
- Production renderer CSP fixes `connect-src` to `'none'`. Only the development-server build adds
  loopback HTTP/WebSocket sources; no remote renderer network origin is allowed.
- The main process validates renderer inputs, verifies every IPC sender against the expected main
  frame and `webContents`, serializes all state reads and mutations, owns file dialogs, and
  enforces exact external-link hosts. Packaged builds never consume a renderer URL from the
  environment; development accepts loopback origins only.
- The desktop app takes an OS single-instance lock before opening career data. SQLite has one
  in-process writer. Imported source bytes and domain payloads are encrypted with
  AES-256-GCM; the 32-byte key is protected by Electron `safeStorage` on supported hosts.
- PDF, DOCX, Markdown, and text parsing is bounded by file, page, archive, extracted-character, and
  fragment limits.
  Before a selected file is read, path and open-handle metadata are compared as bigint
  `dev`/`ino`/`size`/`mtime`/`ctime` values, followed by a second `fstat` after the read. On Windows,
  Electron can report incompatible device IDs for the same path and handle, so the stable bigint
  inode and all remaining metadata are required while the device-ID comparison is omitted.
  The main process performs only bounded path, signature, UTF-8, and ZIP central-directory checks.
  Parser plugins run in a fresh Electron utility process with an empty inherited environment, a
  192 MiB V8 old-generation argument, and a 15-second watchdog; there is no in-process fallback.
  Only one parser process may be active. Every outcome waits for a confirmed child exit, and an
  unconfirmed termination poisons parsing for that application run. All DOCX XML and relationship
  parts receive an 8 MiB declared-size prefilter and, inside the child, a hard bounded actual inflate,
  full-stream-consumption, CRC, and local-entry layout check. Parser output is capped at 2,000,000
  UTF-16 code units, and fragment generation stops at the shared limit rather than building an
  oversized array first. Process requests contain owned bytes and metadata but never a source path
  or command.
- Codex uses the official local App Server. In this Windows alpha, every native `codex.exe`
  candidate is resolved to a real absolute path and accepted only when Authenticode reports
  `Valid` and both signer `CN` and `O` exactly equal `OpenAI OpCo, LLC`. An explicitly supplied
  path receives the same verification, and the chain root must match a pinned SHA-256 fingerprint
  for Microsoft Identity Verification Root. The verifier locates system PowerShell through the
  Windows kernel `GLOBALROOT\\SystemRoot` namespace rather than caller-controlled environment
  variables. A private-alpha broker locks every non-reparse ancestor directory and the target file,
  compares handle file identity, re-verifies under the lock, and retains those handles until process
  creation. The broker and Codex inherit an anonymous, non-inheritable, kill-on-close Job; parent
  pipe loss terminates the Job. Concurrent callers share one startup task, receive no peer before
  initialization, and a cleanup timeout permanently poisons that runtime instead of permitting a
  duplicate process tree. Non-Windows hosts fail closed instead of running an unverified PATH
  command. Each generation thread is ephemeral, read-only, schema-constrained, has no dynamic
  tools, and is interrupted if a tool/server request appears.
- Stateful mutations are serialized so deletion, export, AI completion, and database writes cannot
  overlap through separate renderer calls.
- Shutdown first closes and removes every renderer IPC handler, then synchronously marks the career
  backend as closing. Operations already accepted are drained before storage and Codex are stopped;
  later calls fail without entering the queue. Close is idempotent, so repeated quit events cannot
  start competing teardown sequences.

## Storage and portability

- SQLite enables foreign keys, WAL with `synchronous=FULL`, schema migrations, and authenticated
  encryption for every domain payload. Career-data writes favor commit durability over bulk-write
  throughput.
- Original files are content-addressed and encrypted separately. If OS key protection is
  unavailable and no persistent vault exists, the product switches to an explicit memory-only mode
  and does not leave undecryptable source blobs on disk. If a persistent vault already exists, the
  app exposes a locked state instead of shadowing it with an empty memory workspace; full export is
  blocked, while an explicitly confirmed key-first deletion can still remove the exact vault. On
  Linux, Electron's `basic_text` safeStorage backend is explicitly treated as insecure.
- A resume's renderable document, tailoring rationales, project, version, and evidence-bound claims
  are encrypted domain records committed by one SQLite transaction. The document is revalidated
  against the immutable version and verified evidence at export time.
- “Export all personal data” writes a warning first inside a hidden, unique staging directory,
  creates structured JSON and decrypted originals, then atomically publishes the finished
  directory. A cleanup failure reports the exact plaintext staging path instead of claiming that
  nothing was written.
- All sensitive career files live below one verified directory. “Delete personal vault” closes the
  writer, atomically renames that directory to an internal tombstone, destroys its protected key
  first, then removes the now-unreadable ciphertext. Interrupted cleanup is retried on launch. It
  does not log out the shared Codex account and does not claim to erase earlier user exports,
  backups, filesystem snapshots, or SSD history blocks.
- Older private-alpha encrypted resume sidecars are imported idempotently into the transactional
  draft-artifact record before normal loading. Once every version has an artifact, the legacy file
  is no longer consulted. Startup verifies artifact/version/project/job/claim bindings and fails
  closed on authenticated corruption instead of silently hiding or cross-wiring a draft.
- Encrypted portable backups, restore, cloud sync, FTS, and vector search are not implemented in
  this alpha and must not be advertised.

The launcher controls ordinary path substitution and parent-process loss; it is not an OS privilege
boundary against malware already running as the same Windows account/integrity level. A signed,
reproducibly built native broker replaces the private-alpha PowerShell/in-memory C# broker before a
public release.

## Provider and recruitment-platform boundaries

- `AIProvider` is replaceable; Codex authentication and protocol details do not enter domain
  entities.
- Imported excerpts, interview messages, job descriptions, and verified facts are disclosed per
  operation. The renderer shows the intended range and the main process presents the final native
  confirmation.
- AI output is schema-validated. Model-provided hidden allowlists are discarded; numeric/date
  allowlists are derived deterministically from user-visible, verified claim text. New career facts
  remain pending until user verification. Tailored resume claims retain a revision link, and every
  wording change requires an exact-text user attestation before export. A modified claim invalidates
  that attestation.
- One AI operation is limited to 128 disclosed items and 256 KiB of serialized context. The JSONL
  transport rejects a line over 2 MiB while it is still streaming, validates every envelope, and
  treats a post-write response timeout as outcome-unknown: the transport is poisoned and its process
  tree must be reaped before another App Server can start.
- Connector packages model capability checks and exact one-time authorization, but no recruitment
  platform write path is exposed by the desktop UI.
- BOSS login, collection, greeting, application, resume send, and reply automation remain disabled
  until current terms, official authorization, and legal review all permit a specific capability.
  Other platforms remain manual/read-only design targets.

## Test-only boundaries

- E2E substitutions for isolated user data, fixture selection, and simulated Codex responses are
  enabled only when Electron is not packaged. A packaged build ignores/fails closed on those
  environment hooks.
- The Windows journey validates the production renderer CSP and records runner/build SHA-256
  fingerprints with its artifacts. These checks support release review; they do not turn this
  private alpha into a signed distributable.

## Next hardening gates

1. Run hostile-document corpus, external-memory, and crash-recovery tests against the isolated
   parser utility process in a signed Windows build, including process-level RSS and system-pressure
   observations beyond V8 heap accounting.
2. Add signed Windows packaging, update verification, native PDF/DOCX export, OCR, and crash-safe
   encrypted backup/restore.
3. Add a human-reviewed fact text-edit, dispute, deletion, and merge lifecycle; per-fact AI and
   resume permissions are already independently revocable.
4. Run screen-reader, 200% zoom, and hostile-file testing on the signed build.
