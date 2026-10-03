# OpenJarvis assessment (3 Oct 2026)

[open-jarvis/OpenJarvis](https://github.com/open-jarvis/OpenJarvis) at commit `792131f`. Reviewed read-only.

## What it is

Stanford's Apache-2.0 framework for **local-first** personal AI. It's a Python app (about 190k lines) with Rust mirrors, a CLI, a FastAPI server, a React/Tauri desktop app, a large eval harness and a learning loop that trains on local traces. It's mature: about 7,600 tests in CI. The last tagged release was 1.0.2 in May 2026.

It is built for **one user on their own Mac or PC running local models**. Jennifer is a cloud backend with an iPhone as the main client. Those are different products.

## Decision

**Use OpenJarvis as a reference and port small, specific pieces. Do not run it alongside Jennifer or depend on it.**

### Why not run it as a service next to Jennifer

1. **The AI approves its own actions.** In `agents/proactive_agent.py`, the model's output picks each action's `tier`. If it says "trivial", the action runs immediately, and that includes sending iMessages, deleting email, and accepting or declining invitations. A malicious email could get a message sent with no approval. Jennifer's core rule (the AI only proposes; a separate rules engine decides) exists to stop exactly this, and Scenario E tests it.
2. **Approvals aren't tied to the exact message.** Sends have no outbox, no deduplication and no follow-up check when a send result is unclear.
3. **Outside text is fed straight into the AI's instructions**, with no marker that it is untrusted.
4. **It has a shell tool** with auto-approve paths, and file writes can go anywhere.
5. **Secrets sit in plain files** in `~/.openjarvis/`. It has one shared API key and no roles, passkeys or step-up.
6. **It sends usage analytics to PostHog by default.**
7. **Gmail/Calendar** poll for changes instead of using Google's push notifications; Outlook uses IMAP with an app password; voice is one-shot (no realtime, no interrupting it, no phone calls); and there's no iOS client.

## Ported now

| From OpenJarvis | Into Jennifer |
|---|---|
| `security/injection_scanner.py` patterns: shell injection, URL exfiltration, base64 exfiltration, jailbreak, chat-template delimiters, identity override | `src/security/untrusted.ts` |
| `security/credential_stripper.py`: AWS, GitHub and Slack tokens | `src/security/redaction.ts` |
| `agents/morning_digest.py` section structure and grounding rules | `src/workflows/briefPrompt.ts` (**one rule inverted**: OpenJarvis hides disconnected sources; Jennifer must say she couldn't check them) |

Attribution and the license text are in `THIRD_PARTY_LICENSES`.

## Use later as a reference

| Week | Item | Path in OpenJarvis |
|---|---|---|
| 3 | Gmail email-body decoding checklist (multipart, HTML → text) | `connectors/gmail.py` |
| 9 | Webhook payload formats and signature checks for Twilio, Sendblue and WhatsApp | `channels/*.py`, `server/webhook_routes.py` |
| 11–12 | Morning-brief and email-triage judge rubrics (completeness, prioritization, conciseness, actionability) and synthetic cases | `evals/datasets/`, `evals/scorers/morning_brief.py` |
| 10 | How it routes tasks between a cheap and a strong model | `learning/routing/` |
| 15 | Its learning loop only accepts a change if the eval passes | `learning/learning_orchestrator.py` |

## Revisit if

Bruno adds an always-on Mac. Then a local model there (Ollama) could handle privacy-sensitive summarizing, called directly behind Jennifer's model adapter. Even then, not through OpenJarvis.
