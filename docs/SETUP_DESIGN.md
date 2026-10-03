# Setup design (Week 1)

Source of truth for devices and accounts: [`config/inventory.json`](../config/inventory.json). Open blockers are computed live at `GET /v1/setup`.

## Phone: iPhone 17 Pro Max on AT&T (US)

### What iOS allows

| Want | Possible? | How Jennifer does it |
|---|---|---|
| Talk to Jennifer | ✅ | Jennifer iOS app with push-to-talk, plus App Intents so Siri and Shortcuts can open it ("Ask Jennifer") |
| Jennifer answers calls you miss | ✅ | AT&T **conditional** call forwarding to Jennifer's provider number (below) |
| Jennifer reads or sends your iMessage/SMS | ❌ | iOS gives third-party apps no access to the Messages inbox. Not built, not promised |
| Jennifer drafts a text for you | ✅ | She prepares it; the iOS Messages composer opens and **you** tap send |
| Send things to Jennifer | ✅ | Share extension (text, links, files, screenshots) |
| Always-listening wake word | ⚠️ | Not on iOS for third-party apps. Use Siri plus App Intents, the Action button, or push-to-talk |
| Jennifer texts people | ✅ (her number) | SMS from Jennifer's own provider number, clearly as Bruno's assistant. Never spoofing your AT&T number |

### Call plan: keep the AT&T number, forward only unanswered calls

The spec forbids changing the existing number before testing, so **no porting**. Jennifer gets her own number from the telephony provider (see the Workforce assessment for reusing the existing SignalWire account). AT&T sends her only the calls you don't take:

| Situation | Activate (dial on the iPhone) | Turn off | Check |
|---|---|---|---|
| No answer (~15–20 s) | `**61*<jennifer number>#` | `##61#` | `*#61#` |
| You're on another call | `**67*<jennifer number>#` | `##67#` | `*#67#` |
| Phone off or no signal | `**62*<jennifer number>#` | `##62#` | `*#62#` |

- Turn these on **one at a time**, after Week 8 inbound-call tests pass on the test number.
- Rollback is a single dial (`##61#` etc.) and your phone behaves exactly as before. Keep AT&T voicemail as the fallback until Jennifer's message taking is proven.
- Forwarding moves **calls only. SMS never forwards.**
- AT&T may bill forwarded legs as normal minutes; confirm against your plan.
- Codes verified from public AT&T guides (Oct 2026). Confirm on the device with `*#61#` before relying on them.

### Device prerequisites (owner: Bruno)

1. iOS version (Settings → General → About)
2. Apple Developer Program membership, for TestFlight, push notifications, App Intents and CallKit
3. Apple ID country / App Store region
4. Your AT&T number(s) and which one callers use

## Connector shortlist, in build order

| Order | Connector | Why first | Status |
|---|---|---|---|
| 1 | Primary email (Gmail or Outlook, to confirm) | Highest volume; Week 3 | Needs account + Google OAuth verification (start now, takes weeks) |
| 2 | Primary calendar | Scheduling scenarios; Week 4 | Needs account |
| 3 | Jennifer iOS app (push, share extension, App Intents) | Your main interface; Week 7 | Needs Apple Developer account |
| 4 | Telephony: Jennifer number + AT&T forwarding | Calls; Week 8 | Provider choice. Reuse SignalWire if the Workforce account fits |
| 5 | WhatsApp **Business** (only if you have an eligible business number) | Week 9 candidate | Personal WhatsApp is unsupported |
| — | iMessage/SMS on the AT&T number | Not possible on iOS | Drafts handed to the Messages composer only |
| — | Instagram, Facebook, LinkedIn, X, Telegram | Investigations | Depends on account type and approval |

Nothing is marked `verified` until a real test on your account passes.

## Environments

| Env | Database | Credentials | Purpose |
|---|---|---|---|
| development | Local Postgres (docker compose) / in-memory | Fake providers, dev tokens | Building and the simulator |
| staging | Separate Cloud SQL instance | Test accounts only | Provider app reviews, Week 14 rehearsals |
| production | Separate Cloud SQL instance | Your real accounts, managed vault | Live use after acceptance |

Separate credentials and databases per environment; connector tokens are bound to account and environment (spec §4).
