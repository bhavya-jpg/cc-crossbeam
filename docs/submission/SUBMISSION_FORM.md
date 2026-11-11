# Submission form answers (paste into the form)

## Name of build
Structura

## Tagline / one-liner
Open-weight multi-agent plan check for California ADU permits, routed, guarded and metered through Mozilla Otari.

## GitHub repo
https://github.com/bhavya-jpg/cc-crossbeam/tree/feat/otari-gateway
(First Otari commit: https://github.com/bhavya-jpg/cc-crossbeam/commit/c71d6ad34de90b192e58913b471c384101e0af90)

## Video
<paste your YouTube link here>
(File to upload: ~/Dev/otaris/structura-submission/Structura-demo.mp4, 3:03, Chatterbox voiceover. Thumbnail: thumbnail.png.)

## Website / live link
https://structura-otari.vercel.app

## Tags
Mozilla Otari, open-weight models, multi-agent, civic tech, permitting, housing, ADU, LLM gateway, guardrails, MCP, code execution, Next.js, TypeScript

---

## Describe your Build (Markdown)

### The problem
When a California city reviews plans for an accessory dwelling unit (ADU), it often sends back a corrections letter with
a dozen or more items. Each item cites a different part of state law, the building code or the city's own ordinance.
Working out what each item means, what must change on which sheet, and what only the contractor or an engineer can
answer takes contractors days to weeks, and every resubmission round delays the housing.

### How it works
Structura reads the city's corrections letter and the full plan set, checks each item against California ADU law and
local code, and drafts the response package. Four agents run in sequence, each on its own open-weight model, and every
model call goes through the Otari gateway:

| Agent | Model | Job |
|---|---|---|
| Extractor | Qwen3-VL-235B | Reads the scanned letter and every plan sheet as images |
| Researcher | gpt-oss-120b | Finds the city ordinance and state code each item cites |
| Analyst | DeepSeek-V4-Pro | Computes setbacks, lot coverage and fee thresholds in an Otari code container |
| Drafter | DeepSeek-V4-Pro | Sorts items into fix now / ask the contractor / needs a professional, then drafts the response |

After the analysis, the contractor answers the few questions only they can answer, and the Drafter writes the final
package: a response letter, a professional scope of work and a corrections report.

### Key features
- **Corrections analysis end to end**: from a real city letter and plan set to a sheet-by-sheet response package.
- **Otari Inspector**: a side panel showing, for every call, the model and provider that served it, the attempt count,
  the guardrail verdict, the code container and the cost, plus a Trace Explorer listing every call in the run.
- **Routing and failover**: every role has a backup open-weight model. The "Force Primary Provider Failover" toggle
  makes a real gateway call to an unavailable model and shows the backup serving it.
- **Guardrails**: requests ask the gateway for a prompt-injection check, and Structura ships its own guardrail service
  in the format Otari documents. (otari.ai currently has no hosted guardrail service, so this is recorded honestly in the
  Inspector and in our friction log.)
- **Per-contractor budgets**: each run can spend on its contractor's own Otari key, and a refused budget stops the run
  with a clear hold.
- **MCP**: California ADU law is exposed as an MCP server the gateway can call, with a local tool loop as fallback.
- **Friction log**: `OTARI_FRICTION_LOG.md` documents what we found integrating Otari, including a 30-second CDN timeout
  on non-streamed calls, which we fixed by streaming every request.

### Real results
On a real second-round corrections letter from the City of Placentia (1232 N Jefferson St, a 600 sq ft detached ADU):
- Analysis: 14 correction items read in 14 gateway calls, $0.21, 12 min 27 s.
- Response: final package drafted in 4 turns, $0.09, 1 min 37 s.

### Tech stack
- Mozilla Otari gateway (`/chat/completions` and `/responses`, streaming, code execution, guardrails field, MCP tools,
  virtual keys and budgets, traces)
- Open-weight models: Qwen3-VL-235B, gpt-oss-120b, DeepSeek-V4-Pro (served via DeepInfra through Otari)
- Server: Node.js, Express 5, TypeScript
- Frontend: Next.js 16, React, Tailwind CSS v4, shadcn/ui
- Data: Supabase (with a local stand-in for offline demos)
- Document handling: poppler and ImageMagick for plan-sheet rendering

### Hackathon requirements
- Built on Mozilla Otari: every model call goes through the gateway. The first Otari commit is linked above.
- Uses open-weight models only.
- The friction log and the submission notes are in the repo.
- Origins: Structura began as a fork of the open-source CrossBeam hackathon project (MIT) and replaces its Anthropic
  Agent SDK and Vercel Sandbox runtime with Otari and open-weight models. It is not affiliated with CrossBeam Permits.
