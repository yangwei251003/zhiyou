# Security policy

## Supported version

Only the newest `0.1.x-alpha` pre-release is evaluated. This is an unsigned Windows preview, not a
stable or code-signed release.

## Report privately

Do not open a public issue for a vulnerability or attach a real resume, credential, Codex session,
personal database, or imported document. Use GitHub's private vulnerability report:

https://github.com/yangwei251003/zhiyou/security/advisories/new

Include the affected version, Windows version, minimal reproduction using synthetic data, and the
observed/expected result. Never include authentication tokens or another person's information.

## Product boundary

BossHunter does not bundle Codex credentials, does not automate recruitment-platform writes, and
does not claim to protect against malware already controlling the same Windows account. See
`docs/threat-model.md` and `LEGAL.md` before evaluating the preview.
