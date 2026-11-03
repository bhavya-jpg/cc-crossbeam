# Otari integration friction log

Integrating Otari into CrossBeam (TypeScript, Express 5) for the Mozilla Devs Wilding Hackathon.
First Otari commit: [`c71d6ad`](https://github.com/bhavya-jpg/cc-crossbeam/commit/c71d6ad34de90b192e58913b471c384101e0af90)

**Evidence levels.** *Observed* means we saw it on the wire. *Documented* means an Otari docs page says it.
Live probes used no key, an invalid key, and (from 2026-11-04) a valid workspace key on an organization with no funds.
That key authenticates but is refused before any model runs, so no completion, guardrail verdict or container has been
observed yet.

## 1. API reference pages return HTTP 500

**Status: resolved.** Every page below returned 200 when rechecked later on 2026-11-04, so this needs no action beyond
the monitoring suggestion.

**Evidence:** observed on 2026-11-04, repeatedly over one working session.

Every `api-reference` page we tried returned 500, on both URL trees that `llms.txt` lists:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://docs.otari.ai/api-reference/responses.md                         # 500
curl -s -o /dev/null -w '%{http_code}\n' https://docs.otari.ai/otari/for-integrators/api-reference/code-execution.md  # 500
```

Also failing: `chat`, `organization-traces`, `overview`, `auth`, `tools`, `models`, `traces`.

The index page `otari/for-integrators/api-reference.md` recovered first, and its error-code table is the best single
source we've found.

**Impact:** request and response schemas were unavailable when we wrote the first client, so its header names
came from our project spec and one of them was wrong (see #4).

**Workaround:** the guide pages still load (`otari/for-integrators/tools.md`, `mcp.md`, `guardrails.md`, `traces.md`),
and the docs' `?ask=` query parameter answered schema questions.

**Suggested fix:** alert on 5xx for the reference tree, and publish the OpenAPI document at a stable public URL.

## 2. Traces endpoint: misleading error and no clear programmatic credential

**Evidence:** the error is observed, now with a valid workspace key too; the access rule is documented; the master-key
behaviour is untested.

A bad key on this route is rejected differently from every other route we tried:

```bash
curl -s https://otari.ai/api/v1/organizations/me/traces -H 'Authorization: Bearer invalid-key'
# {"detail":"Invalid master key"}
curl -s https://otari.ai/api/v1/chat/completions -H 'Authorization: Bearer invalid-key' \
  -H 'Content-Type: application/json' -d '{"model":"openai:gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# {"detail":"Invalid API key"}
```

That message suggests a master key is the fix, which led us to plan a dual-key setup: `OTARI_API_KEY` for inference
and `OTARI_MASTER_KEY` for observability. The docs point elsewhere: the
[Agent traces](https://docs.otari.ai/otari/for-integrators/traces.md) page lists this route for "a signed-in member",
and says a header master key "reads no session's content, on any route". `GET /api/v1/traces` is listed for the
deployment operator.

A valid workspace key, which `GET /models` accepts with a 200, gets the same `401 Invalid master key` here and on
`GET /usage/summary`. So the message is wrong for this caller as well: their key is valid, and it's simply not a
credential this route accepts.

**Impact:** an application with API keys has no documented way to read its own traces. We have not tried a master key.

**Workaround:** read `usage.cost_usd` from each response for cost, and capture `Otari-Request-ID` for correlation. Our
Trace Explorer tries the route only when `OTARI_MASTER_KEY` is set, and otherwise shows the telemetry our server
collected, stating which source it used and why.

**Suggested fix:** return an error that names the accepted credential, and document whether a scoped read-only API key
can read traces.

## 3. Three base URLs, with no statement of which to use

**Evidence:** the first two hosts are observed; the EU behaviour is documented, not tested.

| Host | What we found |
|---|---|
| `https://api.otari.ai/api/v1` | Named by the quickstart and routing guides. Serves the API. |
| `https://otari.ai/api/v1` | Not named in the pages we read, but returned the same 401 and 422 responses. |
| `https://eu.api.otari.ai/api/v1` | Documented for EU accounts. The docs say `api.otari.ai` answers an EU key with `421`. |

**Impact:** we cannot tell whether `otari.ai` is a supported host or an accidental alias, or how it treats EU keys.

**Workaround:** the base URL is configurable through `OTARI_BASE_URL`.

**Suggested fix:** state the canonical host in one place, and either document `otari.ai/api/v1` or redirect it.

## 4. Streaming details and container header names are hard to confirm

**Evidence:** documented in guide pages; not yet observed on an authenticated request.

We first logged streaming as undocumented, because the pages we could read at the time did not mention it. It is
covered, but scattered across guides while the reference pages are down:

- `Otari-Guardrails` is not sent on streamed responses
  ([Inference Guardrails](https://docs.otari.ai/otari/for-integrators/guardrails.md)).
- Cost on a stream arrives in the terminal `response.completed` event, per the docs' `?ask=` answer.

The container headers had the same problem. Our spec assumed `X-Otari-Container-Id` and `X-Otari-Container-Expires-At`.
The [Built-in tools](https://docs.otari.ai/otari/for-integrators/tools.md) page names them `Otari-Container-Id` and
`Otari-Container-Expires-At`, with no `X-` prefix. That error was in our spec, not in Otari's docs, but with the
reference pages down there was no single header list to check it against.

**Workaround:** the client accepts both spellings and keeps every Otari header verbatim in `headers.raw`. The pipeline
uses non-streaming calls.

**Suggested fix:** publish one response-header reference covering streaming and non-streaming behaviour.

## 5. An unknown model under a known vendor is reported as a missing provider credential

**Evidence:** observed on 2026-11-04 with a valid workspace key.

```bash
curl -s https://otari.ai/api/v1/responses -H "Authorization: Bearer $OTARI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"openai/otari-demo-unavailable","input":"hi","max_output_tokens":16}'
# 424 {"detail":"No credential is configured for provider 'openai'. An operator can add the provider as a hosted
#      provider, or the organization can add its own provider key.","code":"provider_not_configured"}
```

The ID isn't in `GET /models`, while listed `openai/*` models on the same key reach the funds check instead. The message
sends the reader to provider keys when the actual problem is the model name. The gateway already has the right answer
for an unknown vendor: `notavendor/nope` gets `400 invalid_model`, naming the catalog.

**Impact:** a typo in a model ID looks like an account setup problem. Our first role defaults
(`anthropic:claude-sonnet-5-5` and similar) were not in the catalog at all, and only a catalog check showed that.

**Workaround:** role defaults are now checked against `GET /models`, including `input_modalities` for the role that reads
images.

**Suggested fix:** return the existing `400 invalid_model` for any `vendor/model` ID the catalog doesn't know, before
looking for credentials.

## 6. The workspace web search refusal has no stable code

**Evidence:** observed on 2026-11-04 with a valid workspace key; the promise of a code is documented.

```bash
curl -s https://otari.ai/api/v1/responses -H "Authorization: Bearer $OTARI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-oss-20b","input":"hi","tools":[{"type":"otari_web_search"}]}'
# 403 {"detail":"web search is not enabled for this workspace"}     (no code, no Otari-Error-Code header)
```

The [API reference](https://docs.otari.ai/otari/for-integrators/api-reference.md) says a refusal a caller is expected to
act on carries a stable code. Here a client can't tell this 403 from a guardrail block or a budget refusal without
matching the text. `GET /tools` does report it clearly, as `"available": false, "reason": "workspace_disabled"`.

**Impact:** our runner treated it as retryable and tried a second model, which can't help. It also isn't obvious from the
message where to turn the tool on.

**Workaround:** none needed for the run: it falls back to fewer tools, and the telemetry shows why.

**Suggested fix:** send `Otari-Error-Code: tool_disabled` (or similar) and name the workspace setting in the `detail`.

## Also noted

- **Tool declarations differ:** `otari_web_search` accepts `max_uses`, while `otari_web_fetch` answers
  `400 declarations may contain only the type field`. The docs do show fetch with `type` alone and the error is clear, so
  this was our mistake, caught only by a real request.
- **Guardrails need text:** our real Placentia corrections letter is a scan with no text layer, and the guardrail reads
  text input. We pass any text layer through, but a scanned letter is not really screened.
- **Testing without funds:** a new key gets `402 insufficient_funds` on every model call, so guardrails, tools and
  containers can't be tried at all until the organization is funded. The refusal itself is clear and arrives before
  anything is sent upstream.
- **Two budget refusals:** `402 insufficient_funds` (organization funds) and `403 budget_exceeded` (a key or workspace
  ceiling) are separate. The reference says to map refusals by `code`, which is what we do: a 403 alone can also be a
  guardrail block.

- **API key prefix:** the quickstart says tokens start with `otk_`, while the routing guide's example uses `tk_your_api_key`.
- **Model naming:** guides mix `deepseek/deepseek-v4-pro-0813`, `openai:gpt-4o` and bare `claude-sonnet-4-6`. The rule
  (`provider:model` pins a provider, `vendor/model` is a catalog ID) only surfaced through `?ask=`.
- **Cross-model fallback:** the docs' `?ask=` answer says there is no per-request fallback list across different models;
  it needs a dashboard routing policy. We retry on the client instead, so those retries do not set `Otari-Fallback`, and
  our Inspector labels them as client-side retries.
