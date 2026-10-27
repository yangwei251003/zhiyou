# Third-party notices

BossHunter Next does not bundle Codex. It uses an independently installed, locally authenticated
Codex executable only after the Windows trust checks documented in `docs/architecture.md`.

Production JavaScript dependencies are covered by permissive licenses:

| License                 | Main components                                   |
| ----------------------- | ------------------------------------------------- |
| MIT                     | React, React DOM, Zod, xmldom, JSZip dependencies |
| ISC                     | Lucide React                                      |
| BSD-2-Clause            | Mammoth and related parsers                       |
| BSD-3-Clause/BSD        | parser support libraries                          |
| Apache-2.0              | pdf2json                                          |
| MIT and Zlib            | pako                                              |
| MIT or GPL-3.0-or-later | JSZip; this distribution relies on its MIT option |

The packaged Electron runtime includes its own `LICENSE` and `LICENSES.chromium.html` files. Those
files are shipped beside the executable and remain authoritative for Electron, Chromium, Node.js,
and their bundled components.

Run `pnpm licenses list --prod` against the frozen lockfile for the exact package/version inventory.
This notice is not a substitute for the remaining dependency and distribution review listed in
`LEGAL.md`.
