# Original project audit and clean-room response

This document records the product and engineering conclusions used to define BossHunter Next. It
does not reproduce source code, assets, copy, prompts, or fixtures from the earlier repository.

## Audit method

- Inventoried the repository and reviewed each source, configuration, documentation, and test area.
- Built the frontend and ran the existing isolated test suite; the local suite passed 517 tests,
  while the repository CI configuration did not make that suite a dependable release gate.
- Opened the running product and exercised the primary navigation, forms, dialogs, responsive
  layouts, and job-seeking workflow.
- Reviewed security boundaries around Electron, browser content, credentials, untrusted HTML, and
  external actions.
- Reframed every conclusion as a product requirement before starting this clean-room repository.

## What the earlier project got right

- It recognized a real problem: students and early-career applicants need more than a generic
  resume editor.
- It attempted to join job discovery, resume work, and recruitment communication in one flow.
- It contained meaningful automated tests and enough working behavior to validate the concept.
- Its visible ambition made the missing trust model easy to identify and turn into explicit
  requirements.

## Material gaps observed

### The product treated the resume as the source of truth

There was no durable personal evidence model with source locations, immutable revisions, user
verification, sensitivity, and per-purpose permissions. As a result, each new job risked becoming
another free-form rewrite rather than a safe projection of what the candidate had actually done.

### “AI assistance” lacked a fact lifecycle

The system did not clearly separate source excerpts, AI proposals, user-verified facts, disputed
facts, and resume claims. Confidence could therefore be mistaken for truth, and there was no hard
invariant preventing unsupported dates, numbers, employers, skills, or proficiency from appearing
in an export.

### Job matching was not sufficiently explainable

A single score is attractive but misleading. Applicants need to know which requirement has strong
evidence, weak evidence, an unanswered question, an expression problem, an adjacent capability, or
a true skill gap. The earlier flow did not make those distinctions the center of the experience.

### External actions needed a stricter authority boundary

Recruitment platforms are unstable and high consequence. A robust assistant must bind approval to
the exact account, job, recipient, body, and attachment, consume that approval once, and stop on a
CAPTCHA, session change, DOM change, or uncertain outcome. “Automation” without those properties
creates duplicate-send and wrong-recipient risk.

### Desktop/web security assumptions were too permissive

The audit found browser and HTML trust paths that required stronger isolation. Remote content,
untrusted document text, renderer privileges, external navigation, and platform cookies need
separate process boundaries and allowlists instead of relying on UI intent.

### The interface looked feature-complete before the state was trustworthy

Critical states were not consistently differentiated: proposed versus verified, saved versus sent,
offline versus connected, and analysis versus execution. Some forms and dialogs had weak keyboard
and screen-reader behavior, and narrow-window layouts did not preserve the primary task hierarchy.

## First-principles product decisions

| Question                              | Decision in BossHunter Next                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| What is the durable user asset?       | A local, encrypted career evidence vault—not a resume file.                   |
| What may AI create?                   | Proposals, questions, requirement decompositions, drafts, and learning plans. |
| What may AI declare true?             | Nothing; only the user or a trusted import can verify a fact.                 |
| What is a resume?                     | A versioned, job-specific projection of verified evidence with provenance.    |
| What does “match” mean?               | Explainable requirement coverage, not a hiring probability.                   |
| What may happen externally?           | Only a user-reviewed action with one-time, content-bound authorization.       |
| What happens when outcome is unclear? | Record `outcome_unknown`, reconcile, and never auto-retry.                    |
| What is sent to Codex?                | Only the exact items the user approved for that operation.                    |

## Adversarial acceptance questions

1. Can a malicious sentence inside a resume cause a tool call or file read? It must not.
2. Can an AI-created metric, employer, role, skill, certificate, or qualitative outcome enter an
   export without verified evidence or exact-text user attestation? It must not.
3. Can changing one character after approval preserve an external-action authorization? It must not.
4. Can a disconnected provider appear online because demo data exists? It must not.
5. Can “save draft” be reported as “sent”? It must not.
6. Can a crash after clicking send cause an automatic duplicate on restart? It must not.
7. Can an applicant delete or export local data without hidden plaintext copies? They must be able to.
8. Can the main workflow be completed with a keyboard at 200% zoom? It must be demonstrable.

The implementation and quality gates in this repository are organized around making those answers
testable rather than aspirational.
