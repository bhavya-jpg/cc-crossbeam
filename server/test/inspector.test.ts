import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';

const { OtariClient } = await import('../src/otari/client.js');
const { runDemoScenario } = await import('../src/otari/demo.js');
const { createOtariRouter } = await import('../src/routes/otari.js');
const { runCrossBeamFlow } = await import('../src/otari/runner.js');
const { listConversations, parseTelemetry, summarizeTelemetry } = await import('../../frontend/lib/otari-telemetry.js');

const ENV_KEYS = [
  'OTARI_API_KEY', 'OTARI_MASTER_KEY', 'OTARI_DEMO_SIMULATION', 'OTARI_CONTRACTOR_KEY', 'OTARI_CONTRACTOR_KEY_LABEL',
  'OTARI_CONTRACTOR_BUDGET_USD', 'OTARI_EXHAUSTED_CONTRACTOR_KEY', 'OTARI_EXHAUSTED_CONTRACTOR_KEY_LABEL',
  'OTARI_INSPECTOR_TOKEN', 'OTARI_DEMO_CONTROLS', 'OTARI_DEMO_MODEL', 'OTARI_DEMO_UNAVAILABLE_MODEL',
  'OTARI_MCP_PUBLIC_URL', 'NODE_ENV',
];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
// 1x1 PNG, enough for the extractor to treat the letter as an image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

function fakeStore() {
  const messages: Array<{ role: string; content: string }> = [];
  return {
    messages,
    statuses: [] as string[],
    outputs: [] as unknown[],
    insertMessage: async (_p: string, role: string, content: string) => { messages.push({ role, content }); },
    async updateProjectStatus(_p: string, status: string) { this.statuses.push(status); },
    downloadProjectFile: async () => PNG,
    async createOutputRecord(_p: string, _f: string, data: unknown) { this.outputs.push(data); return 'output-1'; },
    replaceContractorQuestions: async () => {},
  };
}
type Store = ReturnType<typeof fakeStore>;

/** The frontend's parser, fed exactly what the store received. */
const eventsOf = (store: Store) => parseTelemetry(store.messages.map((m, i) => ({ id: i + 1, content: m.content })));

/** A live client whose gateway answers from a script, recording what was sent. */
function scriptedClient(replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ auth: string; body: any }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls.push({ auth: (init.headers as Record<string, string>).Authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as unknown as typeof fetch;
  return { calls, client: new OtariClient({ apiKey: 'workspace-secret', simulation: false, fetch: fetchFn }) };
}

const NO_FUNDS = {
  status: 402,
  body: { detail: 'Insufficient funds ($0.00) to serve this request.', code: 'insufficient_funds' },
  headers: { 'Otari-Error-Code': 'insufficient_funds', 'Otari-Request-ID': 'req-402' },
};
const CHAT_OK = { status: 200, body: { id: 'x', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }], usage: { cost_usd: '0.000010' } }, headers: { 'Otari-Provider': 'groq', 'Otari-Fallback': 'false', 'Otari-Attempt-Count': '1' } };
const RESPONSES_OK = { status: 200, body: { id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { cost_usd: '0.000010' } }, headers: { 'Otari-Provider': 'groq', 'Otari-Fallback': 'false', 'Otari-Attempt-Count': '1' } };

describe('budget refusals in a run', () => {
  const flow = { files: [{ filename: 'corrections.png', storage_path: 'x', file_type: 'corrections-letter' }], flowType: 'corrections-analysis' as const, city: 'Placentia', projectId: PROJECT, userId: USER };

  it('stops on 402 insufficient_funds instead of trying every fallback', async () => {
    const { client, calls } = scriptedClient([NO_FUNDS]);
    const store = fakeStore();
    await assert.rejects(runCrossBeamFlow(flow, { client, store: store as never }), /Insufficient funds/);

    assert.equal(calls.length, 1);
    assert.deepEqual(store.statuses, []);
    assert.equal(store.outputs.length, 0);
    assert.ok(store.messages.some((m) => m.content.startsWith('[OTARI_BUDGET]')));

    const summary = summarizeTelemetry(eventsOf(store));
    assert.equal(summary.budget?.state, 'hold');
    assert.equal(summary.budget?.holdStatus, 402);
    assert.equal(summary.budget?.holdCode, 'insufficient_funds');
    assert.equal(summary.guardrail.tone, 'none', 'a funds refusal says nothing about the guardrail');
  });

  it('stops on 403 budget_exceeded, and it is not mistaken for a guardrail block', async () => {
    const { client, calls } = scriptedClient([{ status: 403, body: { detail: 'API key has exceeded budget limit', code: 'budget_exceeded' }, headers: { 'Otari-Error-Code': 'budget_exceeded', 'Otari-Budget-Scope': 'api_token' } }]);
    const store = fakeStore();
    await assert.rejects(runCrossBeamFlow(flow, { client, store: store as never }), /exceeded budget/);

    assert.equal(calls.length, 1);
    const [event] = eventsOf(store);
    assert.equal(event.budgetHold, true);
    assert.equal(event.blocked, false);
    assert.equal(event.budgetScope, 'api_token');
  });
});

describe('frontend contract with a full simulated run', () => {
  it('fills every panel, with no failover unless one happened', async () => {
    const store = fakeStore();
    await runCrossBeamFlow({ files: [{ filename: 'corrections.png', storage_path: 'x', file_type: 'corrections-letter' }, { filename: 'page-001.png', storage_path: 'y', file_type: 'plan-binder' }], flowType: 'corrections-analysis', city: 'Placentia', projectId: PROJECT, userId: USER }, { client: new OtariClient({ simulation: true }), store: store as never });

    const events = eventsOf(store);
    const summary = summarizeTelemetry(events);
    assert.deepEqual(Object.keys(summary.roles), ['extractor', 'researcher', 'analyst', 'drafter']);
    assert.equal(summary.roles.researcher?.model, 'openai/gpt-oss-120b');
    assert.equal(summary.roles.researcher?.provider, 'mozilla-ai');
    assert.equal(summary.roles.researcher?.failover, false);
    assert.equal(summary.guardrail.label, 'monitor: passed');
    assert.equal(summary.container?.id, 'ctr_otari_9f8a7b');
    assert.equal(summary.container?.turns, 2);
    assert.equal(summary.container?.reused, true);
    assert.ok(summary.container?.expiresAt);
    assert.equal(summary.budget?.keyLabel, 'vk_contractor_placentia_01');
    assert.equal(summary.budget?.keySource, 'simulated');
    assert.equal(summary.budget?.capUsd, 5);
    assert.equal(summary.budget?.state, 'ok');
    assert.ok(Math.abs((summary.budget?.spentUsd ?? 0) - (store.outputs[0] as { agent_cost_usd: number }).agent_cost_usd) < 1e-9);
    assert.equal(listConversations(events).length, 1);
  });
});

describe('demo scenarios, simulated', () => {
  const simulated = () => new OtariClient({ simulation: true });

  it('guardrail block: 403 alert, label and no status change', async () => {
    const store = fakeStore();
    const result = await runDemoScenario('guardrail-block', PROJECT, { client: simulated(), store });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.status, 403);
    assert.equal(result.simulated, true);
    assert.equal(summarizeTelemetry(eventsOf(store)).guardrail.label, '403 Blocked — Prompt Injection Detected');
    assert.ok(store.messages.some((m) => m.content.startsWith('[OTARI_GUARDRAIL]')));
    assert.deepEqual(store.statuses, []);
  });

  it('failover: primary to backup, Otari-Fallback true and attempt count 2', async () => {
    const store = fakeStore();
    const result = await runDemoScenario('provider-failover', PROJECT, { client: simulated(), store });
    assert.equal(result.outcome, 'failed-over');
    const events = eventsOf(store);
    assert.deepEqual(events.map((e) => [e.model, e.status]), [['openai/gpt-oss-120b', 503], ['openai/gpt-oss-20b', 200]]);
    const role = summarizeTelemetry(events).roles.researcher;
    assert.equal(role?.failover, true);
    assert.equal(role?.gatewayFallback, true);
    assert.equal(role?.gatewayAttempts, 2);
    assert.equal(role?.demo, true);
  });

  it('exhausted key: labelled hold when no real spent key is configured', async () => {
    const store = fakeStore();
    const { client, calls } = scriptedClient([CHAT_OK]);
    const result = await runDemoScenario('exhausted-key', PROJECT, { client, store });
    assert.equal(calls.length, 0, 'no call reaches the gateway');
    assert.equal(result.outcome, 'held');
    assert.equal(result.simulated, true);
    assert.equal(result.code, 'budget_exceeded');
    const budget = summarizeTelemetry(eventsOf(store)).budget;
    assert.equal(budget?.state, 'hold');
    assert.equal(budget?.simulated, true);
    assert.equal(budget?.keyLabel, 'vk_contractor_exhausted_00');
  });
});

describe('demo scenarios against a live gateway', () => {
  it('failover is reported as a client retry: the gateway never said it fell back', async () => {
    const { client, calls } = scriptedClient([
      { status: 424, body: { detail: "No credential is configured for provider 'openai'.", code: 'provider_not_configured' } },
      RESPONSES_OK,
    ]);
    const store = fakeStore();
    const result = await runDemoScenario('provider-failover', PROJECT, { client, store });

    assert.equal(result.outcome, 'failed-over');
    assert.equal(result.simulated, false);
    assert.equal(calls[0].body.model, 'openai/otari-demo-unavailable');
    assert.equal(calls[1].body.model, 'openai/gpt-oss-20b');
    assert.equal(calls[1].body.max_output_tokens, 16);
    const role = summarizeTelemetry(eventsOf(store)).roles.researcher;
    assert.equal(role?.failover, true);
    assert.equal(role?.gatewayFallback, false);
    assert.equal(role?.clientAttempts, 2);
    assert.equal(role?.gatewayAttempts, 1);
  });

  it('an unblocked injection payload is reported as not blocked', async () => {
    const { client, calls } = scriptedClient([{ ...CHAT_OK, headers: { ...CHAT_OK.headers, 'Otari-Guardrails': JSON.stringify([{ profile: 'prompt-injection', mode: 'block', valid: null, status: 'unavailable' }]) } }]);
    const store = fakeStore();
    const result = await runDemoScenario('guardrail-block', PROJECT, { client, store });

    assert.equal(result.outcome, 'not-blocked');
    assert.deepEqual(calls[0].body.guardrails, [{ profile: 'prompt-injection', mode: 'block', on_unavailable: 'monitor' }]);
    assert.equal(calls[0].body.max_tokens, 16);
    const { guardrail } = summarizeTelemetry(eventsOf(store));
    assert.equal(guardrail.label, 'block: unavailable');
    assert.equal(guardrail.tone, 'warning');
  });

  it('an unfunded account reports the hold instead of a block', async () => {
    const { client } = scriptedClient([NO_FUNDS]);
    const result = await runDemoScenario('guardrail-block', PROJECT, { client, store: fakeStore() });
    assert.equal(result.outcome, 'held');
    assert.equal(result.status, 402);
    assert.equal(result.simulated, false);
  });

  it('uses the configured spent key for real, and says so if it still has budget', async () => {
    process.env.OTARI_EXHAUSTED_CONTRACTOR_KEY = 'spent-secret';
    const held = scriptedClient([{ status: 403, body: { detail: 'over', code: 'budget_exceeded' }, headers: { 'Otari-Error-Code': 'budget_exceeded' } }]);
    const heldResult = await runDemoScenario('exhausted-key', PROJECT, { client: held.client, store: fakeStore() });
    assert.equal(held.calls[0].auth, 'Bearer spent-secret');
    assert.equal(heldResult.outcome, 'held');
    assert.equal(heldResult.simulated, false);

    const served = scriptedClient([CHAT_OK]);
    const servedResult = await runDemoScenario('exhausted-key', PROJECT, { client: served.client, store: fakeStore() });
    assert.equal(servedResult.outcome, 'not-held');
  });

  it('never writes a key to telemetry', async () => {
    process.env.OTARI_CONTRACTOR_KEY = 'contractor-secret';
    process.env.OTARI_EXHAUSTED_CONTRACTOR_KEY = 'spent-secret';
    const { client } = scriptedClient([NO_FUNDS]);
    const store = fakeStore();
    for (const scenario of ['guardrail-block', 'provider-failover', 'exhausted-key'] as const) {
      await runDemoScenario(scenario, PROJECT, { client, store });
    }
    const all = JSON.stringify(store.messages);
    for (const secret of ['contractor-secret', 'spent-secret', 'workspace-secret']) assert.ok(!all.includes(secret), secret);
    assert.ok(eventsOf(store).every((e) => e.keySource === 'contractor'));
  });
});

describe('inspector routes', () => {
  async function withServer(deps: Partial<Parameters<typeof createOtariRouter>[0]>, test: (url: string) => Promise<void>) {
    const app = express();
    app.use(express.json());
    app.use('/api/otari', createOtariRouter({
      client: new OtariClient({ simulation: true }),
      loadTelemetry: async () => [],
      runDemo: async (scenario) => ({ scenario, outcome: 'held', conversationId: 'c', simulated: true, status: 403, code: null, message: 'm' }),
      ...deps,
    }));
    const server = app.listen(0);
    try {
      await test(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/otari`);
    } finally {
      server.close();
    }
  }
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const demoBody = { project_id: PROJECT, scenario: 'exhausted-key' };
  const conversation = `crossbeam-${PROJECT}-1700000000000`;

  it('fails closed in production without a token, and checks the token when set', async () => {
    await withServer({}, async (url) => {
      process.env.NODE_ENV = 'production';
      assert.equal((await post(url, demoBody)).status, 503);
      assert.equal((await fetch(`${url}/traces/${conversation}`)).status, 503);

      process.env.OTARI_INSPECTOR_TOKEN = 'shared';
      assert.equal((await post(url, demoBody)).status, 401);
      assert.equal((await post(url, demoBody, { Authorization: 'Bearer wrong!' })).status, 401);
      process.env.OTARI_DEMO_CONTROLS = 'true';
      assert.equal((await post(url, demoBody, { Authorization: 'Bearer shared' })).status, 200);
    });
  });

  it('keeps demo controls off in production unless turned on', async () => {
    await withServer({}, async (url) => {
      process.env.NODE_ENV = 'production';
      process.env.OTARI_INSPECTOR_TOKEN = 'shared';
      assert.equal((await post(url, demoBody, { Authorization: 'Bearer shared' })).status, 403);
    });
  });

  it('rejects bad input and overlapping demos', async () => {
    let release = () => {};
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    await withServer({ runDemo: async (scenario) => { await blocker; return { scenario, outcome: 'held', conversationId: 'c', simulated: true, status: 403, code: null, message: 'm' }; } }, async (url) => {
      assert.equal((await post(url, { project_id: PROJECT, scenario: 'nope' })).status, 400);
      assert.equal((await post(url, { project_id: 'nope', scenario: 'exhausted-key' })).status, 400);
      assert.equal((await fetch(`${url}/traces/not-a-conversation`)).status, 400);

      const first = post(url, demoBody);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await post(url, demoBody)).status, 409);
      release();
      assert.equal((await first).status, 200);
    });
  });

  it('falls back to collected telemetry, filtered to the conversation, with the reason', async () => {
    process.env.OTARI_MASTER_KEY = 'master-secret';
    const { client, calls } = scriptedClient([{ status: 401, body: { detail: 'Invalid master key' } }]);
    const lines = [
      `[OTARI_TELEMETRY] ${JSON.stringify({ conversationId: conversation, role: 'analyst', requestId: 'keep' })}`,
      `[OTARI_TELEMETRY] ${JSON.stringify({ conversationId: 'other', role: 'analyst', requestId: 'drop' })}`,
      '[OTARI_TELEMETRY] {broken',
    ];
    await withServer({ client, loadTelemetry: async (id) => { assert.equal(id, PROJECT); return lines; } }, async (url) => {
      const body = await (await fetch(`${url}/traces/${conversation}`)).json();
      assert.equal(calls[0].auth, 'Bearer master-secret');
      assert.equal(body.source, 'collected');
      assert.match(body.reason, /401.*Invalid master key/);
      assert.deepEqual(body.spans.map((s: { requestId: string }) => s.requestId), ['keep']);
      assert.ok(!JSON.stringify(body).includes('master-secret'));
    });
  });

  it('does not offer the workspace key to the traces route', async () => {
    const { client, calls } = scriptedClient([{ status: 401, body: { detail: 'Invalid master key' } }]);
    await withServer({ client }, async (url) => {
      const body = await (await fetch(`${url}/traces/${conversation}`)).json();
      assert.equal(calls.length, 0);
      assert.equal(body.source, 'collected');
      assert.match(body.reason, /OTARI_MASTER_KEY is not set/);
    });
  });

  it('returns the gateway trace when the master key can read it', async () => {
    process.env.OTARI_MASTER_KEY = 'master-secret';
    const { client, calls } = scriptedClient([
      { status: 200, body: { items: [{ trace_id: conversation, workspace_id: 'w1' }], has_more: false } },
      { status: 200, body: { trace_id: conversation, spans: [{ name: 'llm' }] } },
    ]);
    await withServer({ client }, async (url) => {
      const body = await (await fetch(`${url}/traces/${conversation}`)).json();
      assert.equal(calls.length, 2);
      assert.equal(body.source, 'gateway');
      assert.deepEqual(body.trace.spans, [{ name: 'llm' }]);
    });
  });
});
