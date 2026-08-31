# Clean-room and release status

This repository is a new implementation based on independently written product requirements. Do
not copy source code, assets, prompts, documentation text, or test fixtures from the earlier public
BossHunter repository.

The public Windows alpha is source-available for evaluation under an all-rights-reserved notice. It
does not grant redistribution rights and does not bundle or redistribute Codex. Its current Codex
connector accepts only a native Windows executable with `Valid`
Authenticode, exact `OpenAI OpCo, LLC` signer `CN` and `O`, and the pinned Microsoft Identity
Verification root. Explicit paths receive the same locked verification, and non-Windows hosts fail
closed. This technical trust check does not replace a distribution-rights review or provide an OS
boundary against a compromised same-user account. The unsigned GitHub pre-release is not a stable
or generally available release. Before a signed stable release:

1. clear the product name and visual identity;
2. review recruitment-platform automation terms and retain a fail-closed assistive mode;
3. review Codex App Server installation or redistribution requirements;
4. replace the private-alpha PowerShell/in-memory C# broker with a signed reproducible native broker;
5. complete privacy and cross-border data-processing review;
6. add the approved Apache-2.0 license and third-party notices.
