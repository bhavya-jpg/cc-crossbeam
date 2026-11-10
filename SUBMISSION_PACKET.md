# CrossBeam on Otari: submission packet

Developers Wilding: Online. **Submissions close November 11.**
Sources: [event page](https://otari.ai/devs-wilding) and [judging rubric](https://docs.google.com/document/d/1-spnCZ3f2SSki8cb6FnochjchdyttUsjjxfoE6aBnF4/edit).

## 1. Read this first

**How you submit.** The event page says to reply to your sign-up email thread (`marcus+wilding@mozilla.org`), and that a
submission missing any listed item isn't eligible for prizes. It doesn't mention a DoraHacks form. If you also have a
DoraHacks page, section 3 fills it too, but ask @Marcus which one counts.

**The video rules.** The demo must run 3 to 5 minutes. The rubric says video and video feedback "cannot use AI" and must be
a screen recording with your own audio. Section 6 is therefore a shot list with points to cover: say them in your own words.

**Record after the grant lands.** The rubric says "a feature only earns points when it is actually used in the
application." Until the account has funds, no model has answered a request, so most of the table below can't be shown yet.

## 2. Features against the rubric

"Proven live" means seen on a real gateway response. Updated 2026-11-07, after the first funded run on 2026-11-06
(Phase 1 on the Placentia project: 14 calls, $0.21, 12m27s, no replay).

| Rubric item (points) | What the app does | Proven live? | To earn it |
|---|---|---|---|
| One open-weight model (20) | Every role defaults to one | Yes: Qwen3-VL, gpt-oss-120b and DeepSeek V4 Pro all served | Done |
| Two or more, for different purposes (10) | See the model list in section 3 | Yes: vision extraction, research, analysis and drafting | Done |
| Multiple models, distinct roles (10) | 4-stage pipeline, one model per role | Yes | Done |
| Model routing and fallbacks (10) | Client-side retry to a backup model | Yes: a real 424 moved to the backup, which answered 200 | Done. A routing policy is what sets `Otari-Fallback: true` |
| Web search or fetch (10) | Researcher role | No: still `workspace_disabled`, so the researcher ran on local references | Turn both on in your workspace |
| Code execution (10) | Analyst role, container reused across 2 turns | Yes: one container served both analyst turns | Done |
| MCP integrations (10) | `/api/mcp/adu-law` | No: without a public URL the drafter uses a local tool loop, which isn't gateway MCP | `scripts/tunnel.sh`, then one run |
| Guardrails (10) | Prompt-injection check on the extractor | No: otari.ai has no guardrail service (`not_configured`) | `scripts/tunnel.sh` gives the gateway ours; then check Toggle 1 really blocks |
| Budgets and spending limits (10) | Stops on refusal, shows a hold | Partly: a real `402 insufficient_funds` before the grant | A key with a spent ceiling for Toggle 3 (`403 budget_exceeded`) |
| Per-user budgets (10) | One key per contractor via `OTARI_CONTRACTOR_KEY` | No | A contractor key with its own ceiling |

Features cap at 60 points. Web search and MCP both need setup, so check you still reach 60 if you skip one.

### Before you record

1. Turn on web search and web fetch in the workspace. `GET /tools` should stop saying `workspace_disabled`.
2. Create a key with the smallest ceiling and spend it ([guide](https://docs.otari.ai/how-to-guides/set-a-budget-and-ceiling.md)),
   then set it as `OTARI_EXHAUSTED_CONTRACTOR_KEY` in `server/.env`. That variable holds your main key today, so Toggle 3
   reports "not held".
3. Create a contractor key with its own ceiling, and set `OTARI_CONTRACTOR_KEY` and `OTARI_CONTRACTOR_BUDGET_USD`.
4. For MCP and guardrail points: `brew install cloudflared`, start the app, run `scripts/tunnel.sh`, put the printed
   `OTARI_PUBLIC_TOOLS_URL` in `server/.env` and restart the server. The tunnel exposes only the MCP and guardrail
   routes on port 8090, never `/generate`. The Inspector's "Gateway webhooks" section should then say "public".
5. Restart, then do one full Placentia run, Phase 1 and Phase 2, and check Toggle 1 now says blocked. The first run's
   Phase 1 cost $0.21, so the grant covers many runs.

## 3. Submission details

| Field | Value |
|---|---|
| Project name | CrossBeam |
| One line | AI permit review for California ADUs, routed through Otari with open-weight models, guardrails, budgets and a live control-plane inspector |
| Sign-up email | `<the email you registered with>` |
| Public repo | https://github.com/bhavya-jpg/cc-crossbeam |
| Branch | `feat/otari-gateway` |
| First Otari commit | [`c71d6ad`](https://github.com/bhavya-jpg/cc-crossbeam/commit/c71d6ad34de90b192e58913b471c384101e0af90) |
| Otari issues opened | `<links, once you file section 4>` |
| Demo video | `<link>` |
| Feedback | Section 5, and/or `<recording link>` |

**Otari features.** List only what you've shown working by then, from section 2.

**Open-weight models, by role** (override with `OTARI_MODEL_<ROLE>`):

| Role | Primary | Backup | Purpose |
|---|---|---|---|
| Extractor | `alibaba/qwen3-vl-235b-a22b-instruct` | `deepseek/deepseek-v4.1-flash` | Reads plan sheets and letters (vision) |
| Researcher | `openai/gpt-oss-120b` | `openai/gpt-oss-20b` | City code research with web tools |
| Analyst | `deepseek/deepseek-v4-pro-0813` | `deepseek/deepseek-v4.1-flash` | Setback and coverage checks in a code sandbox |
| Drafter | `deepseek/deepseek-v4-pro-0813` | `moonshotai/kimi-k2.6` | Law lookup and deliverables |

## 4. GitHub issues for mozilla-ai/otari

Each was reproduced on 2026-11-04 and searched for duplicates. **Not filed:** these are yours to open. Rerun the commands
first, because the docs outage we'd logged fixed itself the same day.

### Issue 1

**Title:** `/organizations/me/traces` tells a valid workspace key "Invalid master key"

**What happened.** A workspace API key that works on other routes gets an error implying it's the wrong kind of bad key:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://otari.ai/api/v1/models -H "Authorization: Bearer $OTARI_API_KEY"
# 200
curl -s https://otari.ai/api/v1/organizations/me/traces -H "Authorization: Bearer $OTARI_API_KEY"
# 401 {"detail":"Invalid master key"}
curl -s https://otari.ai/api/v1/usage/summary -H "Authorization: Bearer $OTARI_API_KEY"
# 401 {"detail":"Invalid master key"}
```

**Why it matters.** The key isn't invalid. The message sent us off to plan a dual-key setup with a master key, but the
[traces docs](https://docs.otari.ai/otari/for-integrators/traces.md) list this route for "a signed-in member", and say a
header master key "reads no session's content, on any route". An app sending `Otari-Conversation-Id` has no documented way
to read back its own trace, so we show telemetry we collected ourselves.

**Expected.** An error naming what the route accepts, and no `code`-less 401: for example
`{"detail":"This route needs a signed-in session; API keys can't read it","code":"session_required"}`.

**Question.** Could a workspace key get read access to its own workspace's traces? That would make in-app trace views possible.

**Related.** #2690 reports the same message on `/tool-settings/guardrails/profiles`.

### Issue 2

**Title:** Unknown model under a known vendor returns `424 provider_not_configured` instead of `invalid_model`

**What happened.**

```bash
# Unknown vendor: a clear answer.
curl -s https://otari.ai/api/v1/responses -H "Authorization: Bearer $OTARI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"notavendor/nope","input":"hi","max_output_tokens":16}'
# 400 {"detail":"Unknown or unsupported model 'notavendor/nope'. Send a 'provider:model' selector, an alias, or a model id from the catalog (GET /api/v1/models).","code":"invalid_model"}

# Known vendor, a model that doesn't exist: an account problem.
curl -s https://otari.ai/api/v1/responses -H "Authorization: Bearer $OTARI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"openai/otari-demo-unavailable","input":"hi","max_output_tokens":16}'
# 424 {"detail":"No credential is configured for provider 'openai'. An operator can add the provider as a hosted provider, or the organization can add its own provider key.","code":"provider_not_configured"}
```

**Why it matters.** A typo in a model ID reads as an account setup problem, so you go looking in provider keys. Listed
`openai/*` models work on the same key, so the credential message isn't even true of the vendor.

**Expected.** The existing `400 invalid_model` for any `vendor/model` ID not in the catalog, checked before credentials.

**Related.** Item 3 of #2705 sees the same error for a real model on a fresh workspace, where it may be accurate. This issue
is about IDs that don't exist.

### Issue 3

**Title:** Web search refusal has no stable error code, unlike other refusals

**What happened.**

```bash
curl -si https://otari.ai/api/v1/responses -H "Authorization: Bearer $OTARI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-oss-20b","input":"hi","max_output_tokens":16,"tools":[{"type":"otari_web_search"}]}'
# 403, no Otari-Error-Code header
# {"detail":"web search is not enabled for this workspace"}
```

**Why it matters.** The [API reference](https://docs.otari.ai/otari/for-integrators/api-reference.md) says a refusal a caller
is expected to act on carries a stable code, and to map refusals by it. Without one, this 403 can only be told from a
guardrail block or `budget_exceeded` by matching text, which the docs warn may change. Our fallback logic retried another
model, which can't help. `GET /api/v1/tools` already knows the reason (`"reason":"workspace_disabled"`), so the data exists.

**Expected.** The same value as a code on the refusal, such as `Otari-Error-Code: workspace_disabled`, and a `detail` naming
the setting to change. We saw this with web search; web fetch reports the same reason in `GET /tools` and is worth checking.

## 5. Written feedback: the 7 questions

Wording is from the event page. These are drafts from the build record, in your voice: **edit them, and redo anything marked
UPDATE after your first funded run.** Question 7 especially is your call.

**1. What did you build with Otari, and which features did you use? Walk through it on screen.**

CrossBeam reviews California ADU permits: a contractor gives it a city's corrections letter and plan set, and it produces a
response letter, a scope of work for their professionals, and a corrections report. I moved it from Vercel Sandbox and the
Agent SDK onto Otari, replacing a long agent loop with a fixed 4-stage pipeline where each stage uses a different
open-weight model: vision for reading plans, web tools for city rules, code execution for setback checks, and an MCP server
of ADU law for drafting. A drawer in the UI shows routing, failover, guardrail verdicts, container reuse and budget holds
from Otari's response headers. UPDATE: name what you showed working.

**2. What worked well? What you liked, what surprised you.**

The error-code table in the API reference is what I'd want everywhere: mapping refusals by a stable code let me handle "no
funds" and "over budget" as different cases. `Otari-Conversation-Id` and inline `usage.cost_usd` made per-run cost simple.
`GET /models` lists input modalities and prices, which caught that the models I'd first picked for the plan-reading role were
wrong. `GET /tools` tells you exactly why a tool is unavailable. `otari guardrails validate` found a real gap in my policy:
my `.env` gate doesn't see shell reads. The surprise was `?ask=` on docs pages, which answered schema questions while the
reference pages were down. UPDATE: add how real completions felt.

**3. What didn't work? Bugs, friction, anything that cost you time. Reproduction steps if you can.**

Full steps are in `OTARI_FRICTION_LOG.md` and the issues above.
- API reference pages returned 500 for much of my first session, so my first client's header names came from my own spec, and
  one was wrong. They later recovered.
- The traces route answers a valid workspace key with "Invalid master key".
- `openai/<nonexistent>` returns `424 provider_not_configured`, which looks like an account problem.
- The web search 403 has no stable code.
- With $0.00, every model call returns 402, so guardrails, tools and containers couldn't be tested at all. My first real
  requests found a bug my mocks couldn't: `otari_web_fetch` rejects `max_uses`.

**4. What's missing, and what would you change? Features you wanted, what you'd do differently.**

A test mode: a key that returns realistic headers and tool behaviour without spending, so integrations can be checked before
funds arrive. Per-request fallback across different models, without a dashboard routing policy. Read access to a workspace's
own traces with an API key. Guardrail scanning that covers image input, because my real corrections letter is a scan with no
text layer and so isn't really screened. I'd also have checked my role defaults against `GET /models` on day one.

**5. When were you most tempted to skip Otari and call the provider directly? What happened?**

When the account had no funds and I had a whole pipeline I couldn't run end to end. Calling a provider directly would have
told me in minutes whether my prompts worked. I built a recorded-replay mode instead so the app could be exercised while
waiting. UPDATE: if something tempted you once it ran live, say so.

**6. What did you end up building yourself that Otari should've done for you?**

Cross-model fallback in the client, including narrowing tool sets when one is refused. A telemetry store for run spans,
because I couldn't read traces back with an API key. Run-level cost totals and a budget bar: there's no route that simply
says what's left on a key, though `scoped-budgets` gets close. Mapping `Otari-Guardrails` to one verdict.

**7. If the rules hadn't required Otari, would you have continued using Otari? Why or why not?**

YOUR CALL, and it should wait for a funded run. An honest starting point: the control plane is what I'd stay for, since one
key across open-weight vendors, per-key budgets and guardrails would take real work to build myself. What would decide it is
whether the models and tools hold up on a real permit run, and whether I can read traces from my own app.

## 6. Demo video: shot list (about 3:30)

Your own words and voice, per the rubric. Start from clean data:
`rm -rf server/.local-data && ./scripts/run-local.sh --prod`, then open http://localhost:3000.

**If you must record before the grant:** keep the Replay banner visible and say out loud that no model ran. Don't claim
replayed features as working, and consider re-recording once funded.

| Time | On screen | Do | Cover |
|---|---|---|---|
| 0:00 | Sign-in, then dashboard | Click **Sign in** (filled in locally) | The problem: ADU permit corrections cost contractors weeks |
| 0:20 | Project page | Open the contractor card, **Run Live** if offered | Real Placentia plans and a real city corrections letter |
| 0:35 | Project page | Click **Analyze Corrections**, then open the **Otari** tab on the right | Same app, now on Otari. Link the first commit if you like |
| 0:50 | Live Activity and drawer | Let the stages run | Four roles, four jobs. Point at each model pill: these are open-weight models |
| 1:20 | Researcher row, Live Activity | Point at web tool lines | Search and fetch run through the gateway |
| 1:35 | Sandbox panel | Point at the container pill | Code execution checks setbacks; the same container is reused on turn 2 |
| 1:50 | Budget panel | Point at the bar | Real `agent_cost_usd` per call, against this contractor's key |
| 2:05 | Questions form | Answer, click **Submit & Generate Response** | Contractor knowledge goes back in; the drafter uses the ADU law MCP server (only with the tunnel; otherwise say it's the local tool loop) |
| 2:30 | Report | Click through the 3 tabs | The real deliverables |
| 2:50 | Drawer | Toggle **Simulate Prompt Injection PDF** | A block-mode guardrail stops a poisoned document before a provider sees it. State plainly what happened |
| 3:05 | Drawer | Toggle it off, then **Force Primary Provider Failover** | The amber badge: primary fails, the backup serves it |
| 3:20 | Drawer | Toggle it off, then **Switch to Exhausted Contractor Key** | A key with no budget gets a real refusal, and spend stops |
| 3:30 | **Trace Explorer** tab | Open it | Every call by conversation ID. Close on why open-weight models and a gateway suit this |

If the run takes too long for one take, cut the waiting between 0:50 and 2:05 in editing, and say that you did. Your feedback
recording, if you make one, is separate: 3 to 5 minutes on the 7 questions.

## 7. Run it locally

`brew install poppler imagemagick`, then `npm install` in `server/` and `frontend/`.

`server/.env` (template: `server/.env.example`):

```bash
OTARI_API_KEY=<your key>
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=local-service-role
OTARI_HYBRID_FALLBACK=true
OTARI_DEMO_CONTROLS=true
OTARI_INSPECTOR_TOKEN=<openssl rand -hex 32>
OTARI_EXHAUSTED_CONTRACTOR_KEY=<a key with no budget left>
```

`frontend/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=local-anon
NEXT_PUBLIC_CROSSBEAM_LOCAL_MODE=true
SUPABASE_SERVICE_ROLE_KEY=local-service-role
CLOUD_RUN_URL=http://localhost:8080
OTARI_INSPECTOR_TOKEN=<the same value>
```

Then `./scripts/run-local.sh` (`--prod` for recording). For gateway MCP and guardrails, run `scripts/tunnel.sh` in a
second terminal and add the `OTARI_PUBLIC_TOOLS_URL` it prints to `server/.env`. Sign in as `judge@structura.local` / `structura-local`; the local
login form fills these in. The app has no upload screen, so the seeded projects use the real PDFs in `test-assets/corrections/`.
Delete `server/.local-data` to start over.
