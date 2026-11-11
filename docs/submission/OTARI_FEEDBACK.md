# Otari feedback (written)

## What worked well?

The error-code table in the API reference is what I'd want everywhere. Refusals come with a stable code, so I could handle "no funds" (402 insufficient_funds) and "over budget" as different cases and show the contractor a clear hold instead of a crash. Inline `usage.cost_usd` and `Otari-Conversation-Id` made per-run cost tracking simple: our first live run read a real 14-item Placentia corrections letter in 14 gateway calls for $0.21. Streaming works well once you use it: the chat stream ends with a usage chunk, and the `/responses` stream ends with a `response.completed` event carrying the full response, so I got cost and output without a second call. Code execution was the nicest surprise: `container: "auto"` returns an `otari-container-id`, and passing it back let the analyst reuse one container across turns. Fallback was easy to make visible: when a primary model was refused, the backup answered on attempt 2 and `Otari-Attempt-Count` made that easy to show in our Inspector. `GET /models` (modalities and prices) caught that my first pick for the plan-reading role couldn't take images, and `GET /tools` says exactly why a tool is unavailable.

## What didn't work?

Full reproduction steps are in OTARI_FRICTION_LOG.md in our repo.
- **30-second CDN timeout.** Non-streamed calls that run longer than about 30 seconds come back as CloudFront's HTML 504 page, with no `Otari-Request-ID`, so there's nothing to report or trace. Long vision and drafting calls hit this every time. Streaming every request fixed it, but nothing in the docs warns you.
- **No hosted guardrails.** On otari.ai the guardrails field reports `status: unavailable, reason: not_configured`, and block mode without `on_unavailable` returns a 502. A request-level guardrail `url` is accepted and called, but a bad URL only shows up as `evaluation_failed`, with no 400 up front. Streamed responses also don't include the `Otari-Guardrails` header, so a client can't see the verdict.
- **Traces with an API key.** The traces route answers a valid workspace key with "Invalid master key", so I couldn't read my own traces from the app and built a telemetry store instead.
- **Confusing errors.** `openai/<nonexistent-model>` returns `424 provider_not_configured`, which reads like an account problem. The web-search 403 has no stable code.
- **Unfunded accounts can't test anything.** With $0.00 every call returns 402, so guardrails, tools and containers couldn't be tried until funds arrived. My first real request then found a bug my mocks couldn't: `otari_web_fetch` rejects `max_uses`.
- The API reference pages returned 500 for much of my first session.

## What's missing, and what would you change?

- A test mode: a key that returns realistic headers and tool behaviour without spending, so an integration can be checked before funds arrive.
- A clear note, or a JSON error, for the 30-second limit on non-streamed calls, ideally with the request ID kept.
- Hosted guardrails on otari.ai, a verdict header on streamed responses, and guardrail scanning for image input. Our corrections letter is a scan with no text layer, so text-only screening barely sees it.
- Per-request fallback across different models without setting up a dashboard routing policy. I built this in the client, including narrowing tool sets when a tool is refused.
- Read access to a workspace's own traces with an API key, and a simple route for what's left on a key's budget.

---

## Other questions (if the form asks for them)

**What did you build, and which features did you use?** Structura reviews California ADU permits. A contractor gives it the city's corrections letter and plan set, and it produces a response letter, a professional scope of work and a corrections report. Four agents run in sequence on Otari, each on its own open-weight model: Qwen3-VL-235B reads the plans as images, gpt-oss-120b researches city and state code, and DeepSeek-V4-Pro computes setbacks and fees in a code container, then drafts the response. Shown working live: open-weight models in distinct roles, fallback to a backup model, code execution with container reuse, streaming and cost tracking. Built in but blocked on setup or the hosted gateway: web search and fetch (disabled in our workspace), MCP, guardrails and per-contractor budgets.

**When were you most tempted to skip Otari?** Twice. First, while the account had no funds and I had a pipeline I couldn't run end to end; I built a recorded-replay mode to keep working. Second, when long calls kept dying at 30 seconds with an HTML 504 and no request ID. Calling the provider directly would have "worked" right away. Finding out that streaming avoids it kept me on Otari.

**What did you build yourself that Otari should have done?** Cross-model fallback in the client, including narrowing tool sets when one is refused. A telemetry store for run spans, because I couldn't read traces back with an API key. Run-level cost totals and a budget bar. A guardrail service in Otari's documented format, because otari.ai has none configured. Mapping the guardrail header to one verdict.

**Would you keep using Otari without the rule?** Yes, for the control plane. One key across several open-weight vendors, failover, code containers and per-key budgets would take real work to build myself, and the cost visibility is excellent. What would make it an easy yes: streaming-safe errors instead of CDN 504s, hosted guardrails, and traces I can read from my own app.
