import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import express from 'express';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';

const { OtariClient } = await import('../src/otari/client.js');
const { runDemoScenario } = await import('../src/otari/demo.js');
const { createOtariRouter } = await import('../src/routes/otari.js');
const { createCompatApp } = await import('../src/local/supabase-compat.js');
const { runStructuraFlow } = await import('../src/otari/runner.js');
const { listConversations, parseTelemetry, summarizeTelemetry } = await import('../../frontend/lib/otari-telemetry.js');

const ENV_KEYS = [
  'OTARI_API_KEY', 'OTARI_MASTER_KEY', 'OTARI_DEMO_SIMULATION', 'OTARI_CONTRACTOR_KEY', 'OTARI_CONTRACTOR_KEY_LABEL',
  'OTARI_CONTRACTOR_BUDGET_USD', 'OTARI_EXHAUSTED_CONTRACTOR_KEY', 'OTARI_EXHAUSTED_CONTRACTOR_KEY_LABEL',
  'OTARI_INSPECTOR_TOKEN', 'OTARI_DEMO_CONTROLS', 'OTARI_DEMO_MODEL', 'OTARI_DEMO_UNAVAILABLE_MODEL',
  'OTARI_MCP_PUBLIC_URL', 'OTARI_PUBLIC_TOOLS_URL', 'OTARI_GUARDRAIL_URL', 'OTARI_HYBRID_FALLBACK', 'NODE_ENV',
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
    await assert.rejects(runStructuraFlow(flow, { client, store: store as never }), /Insufficient funds/);

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
    await assert.rejects(runStructuraFlow(flow, { client, store: store as never }), /exceeded budget/);

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
    await runStructuraFlow({ files: [{ filename: 'corrections.png', storage_path: 'x', file_type: 'corrections-letter' }, { filename: 'page-001.png', storage_path: 'y', file_type: 'plan-binder' }], flowType: 'corrections-analysis', city: 'Placentia', projectId: PROJECT, userId: USER }, { client: new OtariClient({ simulation: true }), store: store as never });

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
    const { budget, source } = summarizeTelemetry(eventsOf(store));
    assert.equal(budget?.state, 'hold');
    assert.equal(source.simulatedCalls, 1);
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

  it('the demo call is not streamed, so the guardrail header can come back', async () => {
    const { client, calls } = scriptedClient([CHAT_OK]);
    await runDemoScenario('guardrail-block', PROJECT, { client, store: fakeStore() });
    assert.equal(calls[0].body.stream, undefined);
  });

  it('a served, guardrailed call with no verdict says why instead of claiming one', () => {
    const events = parseTelemetry([{ id: 1, content: `[OTARI_TELEMETRY] ${JSON.stringify({ role: 'extractor', stage: 'extract-corrections', model: 'm', status: 200, guardrailMode: 'monitor', guardrailsVerdict: null, costUsd: 0.001 })}` }]);
    const { guardrail } = summarizeTelemetry(events);
    assert.equal(guardrail.label, 'monitor: requested, no verdict on a streamed response');
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

describe('hybrid fallback', () => {
  const flow = {
    files: [{ filename: 'corrections.png', storage_path: 'x', file_type: 'corrections-letter' }, { filename: 'page-01.png', storage_path: 'y', file_type: 'plan-binder' }],
    flowType: 'corrections-analysis' as const, city: 'Placentia', projectId: PROJECT, userId: USER,
  };

  it('calls the gateway first, then runs the whole flow on recorded output, and says so', async () => {
    process.env.OTARI_HYBRID_FALLBACK = 'true';
    const { client, calls } = scriptedClient([NO_FUNDS]);
    const store = fakeStore();
    await runStructuraFlow(flow, { client, store: store as never });

    assert.equal(calls[0].auth, 'Bearer workspace-secret');
    const events = eventsOf(store);
    assert.equal(calls.length, events.length, 'every call reached the gateway');
    assert.ok(events.every((e) => e.replay?.requestId === 'req-402' && e.replay.status === 402 && e.requestId === 'req-402'));
    assert.ok(events.every((e) => e.simulated === false && e.costUsd === 0 && e.provider === null && e.containerId === null));
    assert.deepEqual(store.statuses, ['awaiting-answers']);
    assert.equal(store.messages.filter((m) => m.content.startsWith('[OTARI_REPLAY]')).length, 1);

    // Nothing claims a verdict, a sandbox or spend that never happened.
    const summary = summarizeTelemetry(events);
    assert.equal(summary.guardrail.label, 'monitor: not evaluated, gateway returned 402');
    assert.equal(summary.container, null);
    assert.equal(summary.budget?.state, 'no-funds');
    assert.equal(summary.source.replayedCalls, events.length);
    assert.equal(summary.source.liveCalls, 0);

    // The output is the recorded Placentia run, and is marked as such.
    const output = store.outputs[0] as { agent_cost_usd: number; raw_artifacts: Record<string, any> };
    assert.equal(output.agent_cost_usd, 0);
    assert.match(JSON.stringify(output.raw_artifacts['corrections_parsed.json'].project), /Jefferson/);
    assert.equal(output.raw_artifacts['corrections_parsed.json'].recorded_sample, true);
    assert.equal(output.raw_artifacts['spatial_analysis.json'].execution.code_executed, false);
    assert.equal(output.raw_artifacts['replay.json'].replayed_calls, events.length);
  });

  it('labels replayed deliverables so they cannot pass as model output', async () => {
    process.env.OTARI_HYBRID_FALLBACK = 'true';
    const { client } = scriptedClient([NO_FUNDS]);
    const store = fakeStore();
    await runStructuraFlow({ ...flow, flowType: 'corrections-response', phase1Artifacts: { 'corrections_parsed.json': {} } }, { client, store: store as never });
    const output = store.outputs[0] as Record<string, string>;
    for (const column of ['response_letter_md', 'professional_scope_md', 'corrections_report_md']) {
      assert.ok(output[column].startsWith('> **RECORDED SAMPLE.**'), column);
    }
  });

  it('goes live with no change once the gateway serves the call', async () => {
    process.env.OTARI_HYBRID_FALLBACK = 'true';
    const { client } = scriptedClient([CHAT_OK]);
    const result = await client.chatCompletions({ model: 'm', messages: [] }, { runId: 'r' });
    assert.equal(result.replay, null);
    assert.equal(result.headers.provider, 'groq');
    assert.equal(result.data.choices[0].message.content, 'OK');
  });

  it('only covers insufficient_funds: other refusals stay errors', async () => {
    process.env.OTARI_HYBRID_FALLBACK = 'true';
    for (const reply of [
      { status: 402, body: { detail: 'no price', code: 'pricing_required' }, headers: { 'Otari-Error-Code': 'pricing_required' } },
      { status: 403, body: { detail: 'over', code: 'budget_exceeded' }, headers: { 'Otari-Error-Code': 'budget_exceeded' } },
      { status: 401, body: { detail: 'Invalid API key' } },
    ]) {
      const { client } = scriptedClient([reply]);
      await assert.rejects(client.responses({ model: 'm', input: 'x' }, { runId: 'r' }), { status: reply.status });
    }
  });

  it('is off in production and off by default', async () => {
    const off = scriptedClient([NO_FUNDS]);
    await assert.rejects(off.client.responses({ model: 'm', input: 'x' }, { runId: 'r' }), { status: 402 });

    process.env.OTARI_HYBRID_FALLBACK = 'true';
    process.env.NODE_ENV = 'production';
    const production = scriptedClient([NO_FUNDS]);
    await assert.rejects(production.client.responses({ model: 'm', input: 'x' }, { runId: 'r' }), { status: 402 });
  });

  it('Toggle 3 shows the genuine refusal, never a replay', async () => {
    process.env.OTARI_HYBRID_FALLBACK = 'true';
    process.env.OTARI_EXHAUSTED_CONTRACTOR_KEY = 'zero-balance-secret';
    const { client, calls } = scriptedClient([NO_FUNDS]);
    const store = fakeStore();
    const result = await runDemoScenario('exhausted-key', PROJECT, { client, store });

    assert.equal(calls[0].auth, 'Bearer zero-balance-secret');
    assert.deepEqual([result.outcome, result.status, result.code, result.simulated, result.replay], ['held', 402, 'insufficient_funds', false, null]);
    const { budget, source } = summarizeTelemetry(eventsOf(store));
    assert.equal(budget?.state, 'hold');
    assert.equal(source.liveCalls, 1);
    assert.ok(!JSON.stringify(store.messages).includes('zero-balance-secret'));
  });

  it('Toggles 1 and 2 disclose the replay and keep real failures real', async () => {
    process.env.OTARI_HYBRID_FALLBACK = 'true';
    const block = scriptedClient([NO_FUNDS]);
    const blockStore = fakeStore();
    const blocked = await runDemoScenario('guardrail-block', PROJECT, { client: block.client, store: blockStore });
    assert.equal(blocked.outcome, 'blocked');
    assert.equal(blocked.replay?.requestId, 'req-402');
    assert.match(blocked.message, /^Replay:/);
    assert.equal(summarizeTelemetry(eventsOf(blockStore)).guardrail.label, '403 Blocked — Prompt Injection Detected (replay)');

    const failover = scriptedClient([{ status: 424, body: { detail: 'no credential', code: 'provider_not_configured' } }, NO_FUNDS]);
    const failoverStore = fakeStore();
    const moved = await runDemoScenario('provider-failover', PROJECT, { client: failover.client, store: failoverStore });
    assert.equal(moved.outcome, 'failed-over');
    assert.match(moved.message, /really failed.*replay/);
    const events = eventsOf(failoverStore);
    assert.deepEqual(events.map((e) => [e.status, e.replay?.status ?? null]), [[424, null], [200, 402]]);
    const role = summarizeTelemetry(events).roles.researcher;
    assert.equal(role?.failover, true);
    assert.equal(role?.gatewayFallback, false, 'a client retry is never reported as Otari-Fallback');
  });
});

describe('local Supabase stand-in, through the real supabase-js client', () => {
  let dir: string;
  let server: ReturnType<express.Express['listen']>;
  let flush: () => void;
  let db: SupabaseClient<any, any, any>;
  const CONTRACTOR = 'b0000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-local-'));
    // A dot-directory, like the real server/.local-data.
    const compat = createCompatApp(path.join(dir, '.local-data'));
    flush = compat.flush;
    server = compat.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    db = createClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'local', { auth: { persistSession: false, autoRefreshToken: false } });
  });
  afterEach(() => {
    server.close();
    flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const table = (name: string) => db.schema('crossbeam').from(name);

  it('seeds the judge projects with the binder first, as extract.ts expects', async () => {
    const { data: project } = await table('projects').select('status, city, is_demo').eq('id', CONTRACTOR).single();
    assert.deepEqual(project, { status: 'ready', city: 'Placentia', is_demo: true });
    const { data: files } = await table('files').select('*').eq('project_id', CONTRACTOR);
    assert.equal(files?.[0].filename, 'Binder-1232-N-Jefferson.pdf');
  });

  it('supports the query shapes the app sends', async () => {
    for (const content of ['[OTARI_TELEMETRY] {}', 'plain', '[OTARI_TELEMETRY] {"a":1}']) {
      await table('messages').insert({ project_id: CONTRACTOR, role: 'system', content });
    }
    const { data } = await table('messages').select('id, content').eq('project_id', CONTRACTOR).like('content', '[OTARI_TELEMETRY]%').order('id', { ascending: false });
    assert.equal(data?.length, 2);
    assert.ok(data![0].id > data![1].id);

    const { data: inserted } = await table('outputs').insert({ project_id: CONTRACTOR, flow_phase: 'analysis', version: 1 }).select('id').single();
    assert.ok(inserted?.id);
    const { data: latest } = await table('outputs').select('version').eq('project_id', CONTRACTOR).eq('flow_phase', 'analysis').order('version', { ascending: false }).limit(1);
    assert.deepEqual(latest, [{ version: 1 }]);

    await table('projects').update({ status: 'completed' }).eq('id', CONTRACTOR);
    assert.equal((await table('projects').select('status').eq('id', CONTRACTOR).single()).data?.status, 'completed');

    await table('messages').delete().eq('project_id', CONTRACTOR);
    assert.equal((await table('messages').select('*').eq('project_id', CONTRACTOR)).data?.length, 0);

    const missing = await table('projects').select('*').eq('id', 'nope').single();
    assert.equal(missing.error?.code, 'PGRST116');
  });

  it('enforces the constraints the app relies on', async () => {
    const { error } = await table('contractor_answers').insert({ project_id: CONTRACTOR, question_key: 'q', question_text: 't', question_type: 'select' });
    assert.equal(error?.code, '23514');
  });

  it('signs in the demo user and rejects anything else', async () => {
    const bad = await db.auth.signInWithPassword({ email: 'judge@structura.local', password: 'wrong' });
    assert.ok(bad.error);
    const good = await db.auth.signInWithPassword({ email: 'judge@structura.local', password: 'structura-local' });
    assert.equal(good.error, null);
    const { data } = await db.auth.getUser(good.data.session!.access_token);
    assert.equal(data.user?.email, 'judge@structura.local');
  });

  it('serves demo assets and stored uploads, and stays inside its folders', async () => {
    const { data: pdf } = await db.storage.from('crossbeam-demo-assets').download('corrections/2nd-Review-Corrections-1232-Jefferson-St-Placentia.pdf');
    assert.equal(Buffer.from(await pdf!.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

    const { error } = await db.storage.from('crossbeam-uploads').upload('a/b.bin', Buffer.from('hello'), { upsert: true });
    assert.equal(error, null);
    const { data: stored } = await db.storage.from('crossbeam-uploads').download('a/b.bin');
    assert.equal(await stored!.text(), 'hello');

    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/storage/v1/object`;
    for (const attempt of ['crossbeam-demo-assets/%2e%2e%2f%2e%2e%2fserver%2f.env', 'crossbeam-uploads/%2e%2e%2f%2e%2e%2fdb.json']) {
      assert.equal((await fetch(`${base}/${attempt}`)).status, 404, attempt);
    }
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
