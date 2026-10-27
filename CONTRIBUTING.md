# Contributing

Thanks for helping improve BossHunter Next. This repository is source-available but not currently
open-source licensed; a pull request does not grant redistribution rights.

## Before opening a change

- Use synthetic career data. Never commit resumes, credentials, local vaults, exported personal
  data, or Codex session material.
- Preserve the evidence-first rule: AI output remains unverified until the user confirms it.
- Do not add CAPTCHA bypass, browser fingerprint evasion, bulk applications, unattended greetings,
  or recruitment-platform writes without an approved official integration and legal gate.
- Discuss large product or storage changes in an issue first.

## Local checks

Use Node.js 22.12+ and pnpm 10.33.2.

```text
pnpm install --frozen-lockfile
pnpm quality
pnpm test:coverage
pnpm test:e2e
pnpm audit --audit-level high
```

Windows packaging changes must also pass:

```text
pnpm package:win
pnpm test:packaged
```

Keep commits focused, explain user-visible changes, and include regression evidence for any fixed
failure.
