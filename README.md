# Structura

**Autonomous Civic & Permit Intelligence.** Open-weight multi-agent plan check and municipal code engine on Mozilla Otari.

Structura reads a city's corrections letter and the plan set for a California ADU, checks each item against state law
and local code, and drafts the response package. Every model call goes through the [Otari](https://otari.ai) gateway,
which routes it to an open-weight model, screens it, meters it and records it.

## How it works

Four agents, each with its own open-weight model, run in sequence:

| Stage | Model | What it does | Otari features |
|---|---|---|---|
| Extractor | Qwen3-VL-235B | Reads the scanned letter and all plan sheets as images | Vision routing, prompt-injection guardrail, streaming |
| Researcher | gpt-oss-120b | Finds the city's ADU rules and the state code each item cites | Web search and fetch, narrowed when a workspace turns them off |
| Analyst | DeepSeek-V4-Pro | Computes setbacks, lot coverage and fee thresholds | Code execution, one container reused across turns |
| Drafter | DeepSeek-V4-Pro | Sorts items and writes the questions only the contractor can answer | MCP server of California ADU law, local tool loop as fallback |

Each role has a backup model. Runs spend on a per-contractor virtual key, and a refused budget stops the run with a
clear hold. The workspace's **Otari Inspector** shows the model, provider, guardrail verdict, container and cost of
every call, and three toggles trigger a guardrail block, a provider failover and a budget hold against the real gateway.

The first fully live run, Phase 1 on a real Placentia corrections letter (6 Nov 2026), read 14 correction items in
14 gateway calls for $0.21.

## Run it locally

Needs Node 20+, `brew install poppler imagemagick`, and an Otari API key.

```bash
cd server && npm install && cp .env.example .env     # set OTARI_API_KEY; see the file for the rest
cd ../frontend && npm install                         # frontend/.env.local: see SUBMISSION_PACKET.md, section 7
cd .. && ./scripts/run-local.sh                       # local data store, server and frontend together
```

Open the frontend URL Next prints (http://localhost:3000, or the next free port), then **Open Live Permit Review
Workspace**. Local mode signs in as `judge@structura.local` / `structura-local` for you.

For gateway MCP and guardrails, run `scripts/tunnel.sh` in a second terminal and add the `OTARI_PUBLIC_TOOLS_URL` it
prints to `server/.env`. It exposes only the MCP and guardrail routes, never `/generate`.

## Repository

- `server/`: Express 5 API. `src/otari/` holds the gateway client, the 4-stage runner, streaming, the guardrail
  service, the MCP server and the Inspector's demos.
- `frontend/`: Next.js 16 app.
- `server/skills/`: California ADU law and city references the agents read.
- `test-assets/`: real permit documents for testing (see below).
- `OTARI_FRICTION_LOG.md`: what we found integrating Otari. `SUBMISSION_PACKET.md`: hackathon submission notes.

## Test data attribution

The `test-assets/` directory contains real permit documents used for development and testing:

- **California ADU Handbook** (`adu-handbook-update-2026.pdf`): published by the California Department of Housing and Community Development (HCD). Public government document.
- **Placentia Submittal Requirements**: published by the City of Placentia Building Division. Public government document.
- **Corrections Letter** (`corrections/2nd-Review-Corrections-1232-Jefferson-St-Placentia.pdf`): City of Placentia plan check corrections. Public government correspondence.
- **Architectural Plans, 1232 N Jefferson, Placentia** (`corrections/Binder-1232-N-Jefferson.pdf`): included with permission from the project designer for demonstration purposes.
- **Architectural Plans, 326 Flint Ave, Long Beach** (`approved/FLINT-AVE-326-BADD326126-APPROVED-PLANS.pdf`): included with permission from the project designer for demonstration purposes.

## Origins and license

Structura began as a fork of the open-source CrossBeam hackathon project (MIT), and replaces its Anthropic Agent SDK and
Vercel Sandbox runtime with the Otari gateway and open-weight models. It is not affiliated with CrossBeam Permits.

MIT, see [LICENSE](LICENSE).
