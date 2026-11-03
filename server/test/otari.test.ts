import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';

// services/supabase.ts builds its client on import, so env comes before these imports.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';

const { OtariClient, OtariError, guardrailVerdict, isGuardrailBlock, parseOtariHeaders } = await import('../src/otari/client.js');
const { aduLawMcpRouter, callAduLawTool } = await import('../src/otari/mcp.js');
const { costOfUsage, formatDuration, parseFiles, reachableMcpUrl, runCrossBeamFlow, toQuestionRows } = await import('../src/otari/runner.js');
const { SIMULATED_BANNER } = await import('../src/otari/simulation.js');
const { searchReferences, selectReferences } = await import('../src/otari/skills.js');

type Client = InstanceType<typeof OtariClient>;

const ENV_KEYS = [
  'OTARI_API_KEY', 'OTARI_MASTER_KEY', 'OTARI_DEMO_SIMULATION', 'OTARI_MCP_PUBLIC_URL',
  'MCP_ADU_LAW_TOKEN', 'OTARI_BASE_URL', 'NODE_ENV',
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

function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const sentHeaders = (call: { init: RequestInit }) => call.init.headers as Record<string, string>;

describe('client headers', () => {
  it('extracts the documented headers and accepts the X- spellings', () => {
    const h = parseOtariHeaders(new Headers({
      'Otari-Request-ID': 'r', 'Otari-Provider': 'p', 'Otari-Model': 'm', 'Otari-Fallback': 'true',
      'Otari-Attempt-Count': '2', 'Otari-Guardrails': '[]', 'Otari-Container-Id': 'c',
      'Otari-Container-Expires-At': 'e', 'Otari-Other': 'kept', 'X-Unrelated': 'dropped',
    }));
    assert.deepEqual(
      [h.requestId, h.provider, h.model, h.fallback, h.attemptCount, h.containerId, h.containerExpires],
      ['r', 'p', 'm', 'true', 2, 'c', 'e'],
    );
    assert.equal(h.raw['otari-other'], 'kept');
    assert.equal(h.raw['x-unrelated'], undefined);

    const legacy = parseOtariHeaders(new Headers({ 'X-Otari-Container-Id': 'c2', 'X-Otari-Container-Expires-At': 'e2' }));
    assert.deepEqual([legacy.containerId, legacy.containerExpires], ['c2', 'e2']);
  });

  it('reduces the documented guardrail header to a verdict', () => {
    const entry = (fields: object) => JSON.stringify([{ profile: 'prompt-injection', mode: 'monitor', ...fields }]);
    assert.equal(guardrailVerdict(entry({ valid: true, status: 'evaluated' })), 'passed');
    assert.equal(guardrailVerdict(entry({ valid: false, status: 'evaluated' })), 'flagged');
    assert.equal(guardrailVerdict(entry({ valid: null, status: 'unavailable', reason: 'not_configured' })), 'unavailable');
    assert.equal(guardrailVerdict(entry({ valid: null, status: 'inconclusive' })), 'inconclusive');
    assert.equal(guardrailVerdict('passed'), 'passed');
    assert.equal(guardrailVerdict(null), null);
  });
});

describe('client auth and requests', () => {
  const chat = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
  const okChat = '{"id":"x","model":"m","choices":[]}';

  it('prefers the contractor key, falls back to OTARI_API_KEY, and tags the run', async () => {
    process.env.OTARI_API_KEY = 'env-key';
    const m = mockFetch(200, okChat);
    const client = new OtariClient({ fetch: m.fetchFn, baseUrl: 'https://gw.test/api/v1/' });
    await client.chatCompletions(chat, { runId: 'run-1', contractorKey: 'vk' });
    await client.chatCompletions(chat, { runId: 'run-2', contractorKey: '' });
    assert.equal(sentHeaders(m.calls[0]).Authorization, 'Bearer vk');
    assert.equal(sentHeaders(m.calls[1]).Authorization, 'Bearer env-key');
    assert.equal(sentHeaders(m.calls[0])['Otari-Conversation-Id'], 'run-1');
    assert.equal(m.calls[0].url, 'https://gw.test/api/v1/chat/completions');
  });

  it('uses OTARI_MASTER_KEY only on the traces route', async () => {
    process.env.OTARI_API_KEY = 'env-key';
    process.env.OTARI_MASTER_KEY = 'master';
    const m = mockFetch(200, '{"items":[],"has_more":false}');
    const client = new OtariClient({ fetch: m.fetchFn, baseUrl: 'https://gw.test' });
    await client.listTraces({ limit: 5, skip: undefined });
    assert.equal(m.calls[0].url, 'https://gw.test/organizations/me/traces?limit=5');
    assert.equal(sentHeaders(m.calls[0]).Authorization, 'Bearer master');
    assert.equal(m.calls[0].init.body, undefined);

    await client.chatCompletions(chat, { runId: 'r' });
    assert.equal(sentHeaders(m.calls[1]).Authorization, 'Bearer env-key');
  });

  it('turns gateway errors into OtariError without leaking the key', async () => {
    const m = mockFetch(422, '{"detail":[{"msg":"Field required"}],"code":"invalid_request"}', { 'Otari-Request-ID': 'e-1' });
    const client = new OtariClient({ fetch: m.fetchFn, baseUrl: 'https://gw.test', apiKey: 'SECRET' });
    const error = await client.chatCompletions(chat, { runId: 'r' }).catch((e) => e);
    assert.ok(error instanceof OtariError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'invalid_request');
    assert.equal(error.headers.requestId, 'e-1');
    assert.match(error.message, /Field required/);
    assert.ok(!JSON.stringify({ message: error.message, body: error.body }).includes('SECRET'));
  });

  it('raises OtariError for non-JSON bodies', async () => {
    const bad = new OtariClient({ fetch: mockFetch(502, '<html>').fetchFn, baseUrl: 'https://gw.test', apiKey: 'k' });
    assert.equal((await bad.listTraces().catch((e) => e)).status, 502);
    const weird = new OtariClient({ fetch: mockFetch(200, 'not json').fetchFn, baseUrl: 'https://gw.test', apiKey: 'k' });
    assert.match((await weird.listTraces().catch((e) => e)).message, /expected a JSON/);
  });
});

describe('simulation mode selection', () => {
  const chat = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('simulates without a key, and marks the result', async () => {
    const m = mockFetch(200, '{}');
    const result = await new OtariClient({ fetch: m.fetchFn }).chatCompletions(chat, { runId: 'r' });
    assert.equal(result.simulated, true);
    assert.equal(result.headers.provider, 'mozilla-ai');
    assert.equal(result.headers.raw['otari-simulated'], 'true');
    assert.equal(m.calls.length, 0);
  });

  it('goes live as soon as a key is present', () => {
    assert.equal(new OtariClient({ apiKey: 'k' }).isSimulating(), false);
    assert.equal(new OtariClient().isSimulating('contractor'), false);
    process.env.OTARI_API_KEY = 'k';
    assert.equal(new OtariClient().isSimulating(), false);
  });

  it('OTARI_DEMO_SIMULATION=true wins over a key', () => {
    process.env.OTARI_API_KEY = 'k';
    process.env.OTARI_DEMO_SIMULATION = 'true';
    assert.equal(new OtariClient().isSimulating(), true);
  });

  it('never simulates implicitly in production: it fails before any network call', async () => {
    process.env.NODE_ENV = 'production';
    const m = mockFetch(200, '{}');
    const client = new OtariClient({ fetch: m.fetchFn });
    assert.equal(client.isSimulating(), false);
    await assert.rejects(client.chatCompletions(chat, { runId: 'r' }), /no API key/);
    assert.equal(m.calls.length, 0);
  });

  it('production can still opt in to the demo explicitly', () => {
    process.env.NODE_ENV = 'production';
    process.env.OTARI_DEMO_SIMULATION = 'true';
    assert.equal(new OtariClient().isSimulating(), true);
  });
});

describe('ADU law references', () => {
  it('ranks setback documents first for a setback query', () => {
    const [top] = searchReferences('side and rear setback', { skills: ['california-adu'] });
    assert.equal(top.id, 'california-adu/standards-setbacks');
  });

  it('selects documents only from the requested skills', () => {
    const selected = selectReferences('setback', ['placentia-adu'], { limit: 3, maxCharsEach: 100 });
    assert.ok(selected.length > 0);
    assert.ok(selected.every(({ id, text }) => id.startsWith('placentia-adu/') && text.length <= 100));
  });

  it('resolves only indexed ids, so paths cannot escape the library', () => {
    for (const id of ['../../package', '../../../.env', 'california-adu/../../../package', '/etc/passwd', 'adu-plan-review/SKILL']) {
      assert.equal(callAduLawTool('read_reference', { id }).isError, true, id);
    }
    assert.equal(callAduLawTool('read_reference', { id: 'california-adu/standards-setbacks' }).isError, false);
    assert.equal(callAduLawTool('read_reference', {}).isError, true);
    assert.equal(callAduLawTool('nope', {}).isError, true);
  });
});

describe('MCP endpoint', () => {
  async function withServer<T>(run: (url: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use(express.json());
    app.use('/api/mcp/adu-law', aduLawMcpRouter);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp/adu-law`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  const rpc = (url: string, body: object, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

  it('completes the MCP handshake, tool listing and a tool call', async () => {
    await withServer(async (url) => {
      const init = await (await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json() as any;
      assert.equal(init.result.protocolVersion, '2025-03-26');
      assert.ok(init.result.capabilities.tools);

      assert.equal((await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

      const list = await (await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as any;
      assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['list_references', 'search_references', 'read_reference']);

      const call = await (await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_reference', arguments: { id: 'california-adu/standards-setbacks' } } })).json() as any;
      assert.equal(call.result.isError, false);
      assert.match(call.result.content[0].text, /4 feet/);

      const unknown = await (await rpc(url, { jsonrpc: '2.0', id: 4, method: 'nope' })).json() as any;
      assert.equal(unknown.error.code, -32601);
      assert.equal((await fetch(url)).status, 405);
      assert.equal((await rpc(url, { nonsense: true })).status, 400);
    });
  });

  it('requires the bearer token when one is configured', async () => {
    process.env.MCP_ADU_LAW_TOKEN = 'secret-token';
    await withServer(async (url) => {
      const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
      assert.equal((await rpc(url, body)).status, 401);
      assert.equal((await rpc(url, body, { Authorization: 'Bearer wrong-token-' })).status, 401);
      assert.equal((await rpc(url, body, { Authorization: 'Bearer secret-token' })).status, 200);
    });
  });

  it('only offers the MCP path for a URL the gateway could reach', () => {
    assert.equal(reachableMcpUrl(), null);
    process.env.OTARI_MCP_PUBLIC_URL = 'http://localhost:8080/api/mcp/adu-law';
    assert.equal(reachableMcpUrl(), null);
    process.env.OTARI_MCP_PUBLIC_URL = 'https://cb.example.com/api/mcp/adu-law';
    assert.equal(reachableMcpUrl(), 'https://cb.example.com/api/mcp/adu-law');
    process.env.OTARI_MCP_PUBLIC_URL = 'http://cb.example.com/api/mcp/adu-law';
    assert.equal(reachableMcpUrl(), 'http://cb.example.com/api/mcp/adu-law');
    process.env.MCP_ADU_LAW_TOKEN = 't';
    assert.equal(reachableMcpUrl(), null);
  });
});

describe('runner helpers', () => {
  it('prefers reported cost and estimates per 1k tokens otherwise', () => {
    assert.deepEqual(costOfUsage({ cost_usd: '0.012400', input_tokens: 1 }), { costUsd: 0.0124, costSource: 'reported' });
    const estimated = costOfUsage({ input_tokens: 1000, output_tokens: 1000 });
    assert.equal(estimated.costSource, 'estimated');
    assert.ok(Math.abs(estimated.costUsd - 0.018) < 1e-9);
    assert.deepEqual(costOfUsage(undefined), { costUsd: 0, costSource: 'estimated' });
  });

  it('formats durations for the frontend completion message', () => {
    assert.equal(formatDuration(0), '0m 0s');
    assert.equal(formatDuration(125_400), '2m 5s');
  });

  it('parses only expected files, and rejects invalid JSON', () => {
    const text = '<file name="a.json">\n```json\n{"x":1}\n```\n</file>\n<file name="b.json">{oops</file>\n<file name="c.md">\n# Hi\n</file>\n<file name="../evil.md">no</file>';
    assert.deepEqual(parseFiles(text, ['a.json', 'b.json', 'c.md']), { 'a.json': { x: 1 }, 'c.md': '# Hi' });
  });

  it('writes question rows that satisfy the table constraint and the form', () => {
    const rows = toQuestionRows({
      question_groups: [{
        correction_item_id: '4',
        research_context: 'group context',
        questions: [
          { question_id: 'q1', question_text: 'Size?', question_type: 'choice', options: ['3"', '4"'], context: 'why' },
          { question_id: 'q2', question_text: 'Grade?', question_type: 'measurement' },
          { question_id: 'q3', question_text: 'Sprinklers?', question_type: 'yes_no' },
          { question_id: 'q4', question_text: 'Other?', question_type: 'multi_choice' },
        ],
      }],
      professional_items: [{ correction_item_id: '5', contractor_question: { question_id: 'q5', question_text: 'Framing?', question_type: 'text' } }],
    }, 'p');

    assert.deepEqual(rows.map((r) => r.question_key), ['q1', 'q2', 'q3', 'q4', 'q5']);
    assert.deepEqual(rows.map((r) => r.question_type), ['choice', 'measurement', 'choice', 'text', 'text']);
    assert.ok(rows.every((r) => ['text', 'number', 'choice', 'measurement'].includes(r.question_type)));
    assert.deepEqual(rows[0].options, ['3"', '4"']);
    assert.equal(rows[0].question_text, 'Size?');
    assert.equal(rows[0].context, 'why');
    assert.equal(rows[1].context, 'group context');
    assert.equal(rows[4].correction_item_id, '5');
  });
});

// --- End-to-end through simulation mode ---

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

function pageArchive(pageCount: number): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'pages-png'));
    for (let i = 1; i <= pageCount; i += 1) {
      fs.writeFileSync(path.join(dir, 'pages-png', `page-${String(i).padStart(2, '0')}.png`), TINY_PNG);
    }
    const archive = path.join(dir, 'pages.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', dir, 'pages-png']);
    return fs.readFileSync(archive);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeStore(downloads: Record<string, Buffer>) {
  const log = {
    messages: [] as Array<{ role: string; content: string }>,
    statuses: [] as string[],
    outputs: [] as Array<{ phase: string; data: Record<string, any> }>,
    questions: [] as Array<{ rows: any[]; outputId: string }>,
  };
  return {
    log,
    store: {
      insertMessage: async (_id: string, role: string, content: string) => { log.messages.push({ role, content }); },
      updateProjectStatus: async (_id: string, status: string) => { log.statuses.push(status); },
      downloadProjectFile: async (storagePath: string) => {
        const data = downloads[storagePath];
        if (!data) throw new Error(`missing ${storagePath}`);
        return data;
      },
      createOutputRecord: async (_id: string, phase: string, data: Record<string, unknown>) => {
        log.outputs.push({ phase, data });
        return 'output-1';
      },
      replaceContractorQuestions: async (_id: string, rows: any[], outputId: string) => { log.questions.push({ rows, outputId }); },
    },
  };
}

/** The simulation, recording the real request bodies and call options the runner sends. */
class SpyClient extends OtariClient {
  bodies: Array<{ endpoint: string; stage?: string; body: any; runId: string; contractorKey?: string | null }> = [];
  failModels = new Set<string>();

  constructor() {
    super({ simulation: true });
  }
  private record(endpoint: string, body: any, options: any) {
    this.bodies.push({ endpoint, stage: options.simStage, body, runId: options.runId, contractorKey: options.contractorKey });
    if (this.failModels.has(body.model)) {
      throw new OtariError('Otari 404: unknown model', 404, null, {}, parseOtariHeaders(new Headers({ 'Otari-Request-ID': 'failed' })));
    }
  }
  override chatCompletions(body: any, options: any) {
    try { this.record('chat', body, options); } catch (error) { return Promise.reject(error); }
    return super.chatCompletions(body, options);
  }
  override responses(body: any, options: any) {
    try { this.record('responses', body, options); } catch (error) { return Promise.reject(error); }
    return super.responses(body, options);
  }
}

const IDS = { projectId: '11111111-1111-1111-1111-111111111111', userId: '22222222-2222-2222-2222-222222222222' };
const ANALYSIS_FILES = [
  { filename: 'corrections-1.png', storage_path: 'crossbeam-uploads/corrections-1.png', file_type: 'corrections-letter' },
  { filename: 'pages-png.tar.gz', storage_path: 'crossbeam-uploads/pages-png.tar.gz', file_type: 'other' },
];
const downloads = () => ({
  'crossbeam-uploads/corrections-1.png': TINY_PNG,
  'crossbeam-uploads/pages-png.tar.gz': pageArchive(7),
});
const telemetryOf = (messages: Array<{ content: string }>) =>
  messages.filter((m) => m.content.startsWith('[OTARI_TELEMETRY] ')).map((m) => JSON.parse(m.content.slice('[OTARI_TELEMETRY] '.length)));

describe('runCrossBeamFlow: corrections-analysis', () => {
  async function run(client: SpyClient = new SpyClient(), extra: object = {}) {
    const { store, log } = fakeStore(downloads());
    await runCrossBeamFlow(
      { ...IDS, files: ANALYSIS_FILES, flowType: 'corrections-analysis', city: 'Placentia', address: '1 Main St', ...extra },
      { client: client as Client, store: store as any },
    );
    return { client, log };
  }

  it('produces the same rows the frontend reads', async () => {
    const { log } = await run();

    assert.deepEqual(log.statuses, ['awaiting-answers']);
    assert.equal(log.outputs.length, 1);
    const { phase, data } = log.outputs[0];
    assert.equal(phase, 'analysis');
    assert.ok(data.corrections_analysis_json);
    assert.ok(data.contractor_questions_json);
    for (const name of ['corrections_parsed.json', 'sheet-manifest.json', 'sheet_observations.json', 'city_research_findings.json', 'spatial_analysis.json', 'state_law_findings.json', 'corrections_categorized.json', 'contractor_questions.json']) {
      assert.ok(name in data.raw_artifacts, name);
    }

    assert.equal(log.questions[0].outputId, 'output-1');
    const [choice] = log.questions[0].rows;
    assert.equal(choice.question_type, 'choice');
    assert.ok(Array.isArray(choice.options));
    assert.match(choice.question_text, /SIMULATED/);

    const contents = log.messages.map((m) => m.content);
    assert.ok(contents.some((c) => /^Completed in \d+m \d+s$/.test(c)));
    assert.ok(contents.some((c) => c.startsWith('[OTARI_SIMULATION]')));
    for (const role of log.messages.map((m) => m.role)) assert.ok(['system', 'assistant', 'tool'].includes(role));
  });

  it('counts every Otari call and reports its telemetry', async () => {
    const { client, log } = await run();
    const telemetry = telemetryOf(log.messages);
    const { data } = log.outputs[0];

    assert.equal(data.agent_turns, client.bodies.length);
    assert.equal(telemetry.length, client.bodies.length);
    assert.ok(data.agent_cost_usd > 0);
    assert.ok(Math.abs(telemetry.reduce((sum, t) => sum + t.costUsd, 0) - data.agent_cost_usd) < 1e-9);
    assert.ok(data.agent_duration_ms >= 0);

    for (const entry of telemetry) {
      for (const field of ['role', 'model', 'provider', 'requestId', 'fallback', 'attemptCount', 'guardrailsVerdict', 'containerId', 'costUsd']) {
        assert.ok(field in entry, field);
      }
      assert.equal(entry.simulated, true);
    }
    assert.deepEqual([...new Set(telemetry.map((t) => t.role))], ['extractor', 'researcher', 'analyst', 'drafter']);
    assert.equal(telemetry.find((t) => t.role === 'extractor').guardrailsVerdict, 'passed');
    assert.equal(telemetry.find((t) => t.role === 'researcher').costSource, 'estimated');
    assert.equal(telemetry.find((t) => t.role === 'researcher').fallback, false);
    assert.equal(telemetry.find((t) => t.role === 'drafter').costSource, 'reported');
  });

  it('sends each role the documented request shape', async () => {
    const { client } = await run();
    const byStage = (stage: string) => client.bodies.filter((b) => b.stage === stage);

    const [extract] = byStage('extract-corrections');
    assert.equal(extract.endpoint, 'chat');
    assert.deepEqual(extract.body.guardrails, [{ profile: 'prompt-injection', mode: 'monitor', on_unavailable: 'monitor' }]);
    assert.ok(extract.body.messages[1].content.some((part: any) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/')));

    // 7 pages make two batches of at most 5.
    const sheets = byStage('extract-sheets');
    assert.equal(sheets.length, 2);
    assert.ok(sheets.every((s) => s.body.messages[1].content.filter((p: any) => p.type === 'image_url').length <= 5));
    assert.ok(sheets.every((s) => s.body.guardrails));

    const [research] = byStage('research');
    assert.equal(research.endpoint, 'responses');
    assert.equal(research.body.model, 'openai/gpt-oss-120b');
    assert.deepEqual(research.body.tools, [{ type: 'otari_web_search', max_uses: 5 }, { type: 'otari_web_fetch' }]);
    assert.equal(research.body.mcp_servers, undefined);

    const draft = byStage('draft-analysis');
    assert.ok(draft.length >= 2, 'local tool loop takes more than one round');
    assert.equal(draft[0].body.mcp_servers, undefined);
    assert.ok(draft[0].body.tools.every((t: any) => t.type === 'function'));
    const finalInput = draft[draft.length - 1].body.input;
    const toolOutput = finalInput.find((item: any) => item.type === 'function_call_output');
    assert.equal(toolOutput.call_id, 'call_sim_1');
    assert.match(toolOutput.output, /setback/i);

    assert.equal(new Set(client.bodies.map((b) => b.runId)).size, 1);
  });

  it('reuses the code container on turn 2 and records that it did', async () => {
    const { client, log } = await run();
    const compute = client.bodies.find((b) => b.stage === 'spatial-compute')!;
    const verify = client.bodies.find((b) => b.stage === 'spatial-verify')!;
    assert.deepEqual(compute.body.tools, [{ type: 'otari_code_execution', container: 'auto' }]);
    assert.deepEqual(verify.body.tools, [{ type: 'otari_code_execution', container: 'ctr_otari_9f8a7b' }]);

    const { execution } = log.outputs[0].data.raw_artifacts['spatial_analysis.json'];
    assert.deepEqual(execution, {
      code_executed: true,
      container_id_turn_1: 'ctr_otari_9f8a7b',
      container_id_turn_2: 'ctr_otari_9f8a7b',
      container_reused: true,
    });
  });

  it('uses mcp_servers instead of the local loop when the gateway can reach the server', async () => {
    process.env.OTARI_MCP_PUBLIC_URL = 'https://cb.example.com/api/mcp/adu-law';
    process.env.MCP_ADU_LAW_TOKEN = 'tok';
    const { client } = await run();
    const draft = client.bodies.filter((b) => b.stage === 'draft-analysis');
    assert.equal(draft.length, 1);
    const [server] = draft[0].body.mcp_servers;
    assert.equal(server.url, 'https://cb.example.com/api/mcp/adu-law');
    assert.equal(server.authorization_token, 'tok');
    assert.deepEqual(server.allowed_tools, ['list_references', 'search_references', 'read_reference']);
    assert.equal(draft[0].body.tools, undefined);
  });

  it('falls back to the next model and reports it', async () => {
    const client = new SpyClient();
    client.failModels.add('deepseek/deepseek-v4-pro-0813');
    const { log } = await run(client);

    const analyst = telemetryOf(log.messages).filter((t) => t.role === 'analyst');
    assert.equal(analyst[0].status, 404);
    assert.equal(analyst[1].model, 'deepseek/deepseek-v4.1-flash');
    assert.equal(analyst[1].fallback, true);
    assert.deepEqual(log.statuses, ['awaiting-answers']);

    // Turn 2 stays on the model that served turn 1, and still reuses its container.
    const verify = client.bodies.filter((b) => b.stage === 'spatial-verify');
    assert.deepEqual(verify.map((b) => b.body.model), ['deepseek/deepseek-v4.1-flash']);
    assert.equal(log.outputs[0].data.raw_artifacts['spatial_analysis.json'].execution.container_reused, true);
  });

  it('narrows the researcher tools when the deployment refuses web fetch', async () => {
    class NoFetch extends SpyClient {
      override responses(body: any, options: any) {
        if (body.tools?.some((t: any) => t.type === 'otari_web_fetch')) {
          this.bodies.push({ endpoint: 'responses', stage: options.simStage, body, runId: options.runId });
          return Promise.reject(new OtariError('Otari 400: web fetch disabled', 400, null, {}, parseOtariHeaders(new Headers())));
        }
        return super.responses(body, options);
      }
    }
    const client = new NoFetch();
    const { log } = await run(client);
    const research = client.bodies.filter((b) => b.stage === 'research');
    assert.deepEqual(research.at(-1)!.body.tools, [{ type: 'otari_web_search', max_uses: 5 }]);
    assert.deepEqual(log.statuses, ['awaiting-answers']);
  });

  it('stops immediately on a rejected key instead of trying other models', async () => {
    class BadKey extends SpyClient {
      override chatCompletions(body: any, options: any) {
        this.bodies.push({ endpoint: 'chat', stage: options.simStage, body, runId: options.runId });
        return Promise.reject(new OtariError('Otari 401: Invalid API key', 401, null, {}, parseOtariHeaders(new Headers())));
      }
    }
    const client = new BadKey();
    await assert.rejects(run(client), /Invalid API key/);
    assert.equal(client.bodies.length, 1);
  });

  it('stops before later stages when the guardrail blocks', async () => {
    const client = new SpyClient();
    const { store, log } = fakeStore(downloads());
    await assert.rejects(
      runCrossBeamFlow(
        { ...IDS, files: ANALYSIS_FILES, flowType: 'corrections-analysis', city: 'Placentia', simulateGuardrailBlock: true },
        { client: client as Client, store: store as any },
      ),
      (error: unknown) => isGuardrailBlock(error),
    );

    assert.equal(client.bodies.length, 1);
    assert.equal(client.bodies[0].body.guardrails[0].mode, 'block');
    assert.match(JSON.stringify(client.bodies[0].body.messages[1].content), /Ignore all previous instructions/);
    assert.equal(telemetryOf(log.messages)[0].guardrailsVerdict, 'flagged');
    assert.ok(log.messages.some((m) => m.content.startsWith('[OTARI_GUARDRAIL]')));
    assert.equal(log.outputs.length, 0);
    assert.deepEqual(log.statuses, []);
  });

  it('fails clearly when there is no corrections letter', async () => {
    const { store, log } = fakeStore(downloads());
    await assert.rejects(
      runCrossBeamFlow(
        { ...IDS, files: [ANALYSIS_FILES[1]], flowType: 'corrections-analysis', city: 'Placentia' },
        { client: new SpyClient() as Client, store: store as any },
      ),
      /No readable corrections letter/,
    );
    assert.ok(log.messages.some((m) => m.content.startsWith('Agent error:')));
  });

  it('passes the contractor key through on every call', async () => {
    const { client } = await run(new SpyClient(), { apiKey: 'vk-contractor' });
    assert.ok(client.bodies.every((b) => b.contractorKey === 'vk-contractor'));
  });

  it('does not reuse the Placentia manifest for another city', async () => {
    const { store, log } = fakeStore(downloads());
    await runCrossBeamFlow(
      { ...IDS, files: ANALYSIS_FILES, flowType: 'corrections-analysis', city: 'Fresno' },
      { client: new SpyClient() as Client, store: store as any },
    );
    const manifest = log.outputs[0].data.raw_artifacts['sheet-manifest.json'];
    assert.ok(manifest.sheets.every((sheet: { sheet_id: string }) => sheet.sheet_id === 'SIM-1'));
  });
});

describe('runCrossBeamFlow: corrections-response', () => {
  it('runs only the drafter and writes the three deliverables, labelled as simulated', async () => {
    const client = new SpyClient();
    const { store, log } = fakeStore({});
    await runCrossBeamFlow(
      {
        ...IDS,
        files: [],
        flowType: 'corrections-response',
        city: 'Placentia',
        phase1Artifacts: { 'corrections_categorized.json': { items: [{ item_number: '1' }] } },
        contractorAnswersJson: '[{"question_key":"q1","answer_text":"4 inch"}]',
      },
      { client: client as Client, store: store as any },
    );

    assert.ok(client.bodies.every((b) => b.stage === 'draft-response'));
    assert.match(JSON.stringify(client.bodies[0].body.input), /4 inch/);

    const { phase, data } = log.outputs[0];
    assert.equal(phase, 'response');
    for (const column of ['response_letter_md', 'professional_scope_md', 'corrections_report_md']) {
      assert.ok(data[column].startsWith(SIMULATED_BANNER.trim()), column);
    }
    assert.ok('sheet_annotations.json' in data.raw_artifacts);
    assert.deepEqual(log.statuses, ['completed']);
    assert.equal(log.questions.length, 0);
  });

  it('fails clearly without Phase 1 artifacts', async () => {
    const { store } = fakeStore({});
    await assert.rejects(
      runCrossBeamFlow(
        { ...IDS, files: [], flowType: 'corrections-response', city: 'Placentia' },
        { client: new SpyClient() as Client, store: store as any },
      ),
      /Phase 1 analysis artifacts/,
    );
  });
});

describe('runCrossBeamFlow: city-review', () => {
  it('writes the corrections letter columns and completes', async () => {
    const client = new SpyClient();
    const { store, log } = fakeStore(downloads());
    await runCrossBeamFlow(
      { ...IDS, files: [ANALYSIS_FILES[1]], flowType: 'city-review', city: 'Placentia' },
      { client: client as Client, store: store as any },
    );

    const { phase, data } = log.outputs[0];
    assert.equal(phase, 'review');
    assert.ok(data.corrections_letter_md.startsWith(SIMULATED_BANNER.trim()));
    assert.ok(data.review_checklist_json);
    assert.ok(!client.bodies.some((b) => b.stage === 'extract-corrections'));
    assert.deepEqual(log.statuses, ['completed']);
  });

  it('refuses to review a project with no plan pages', async () => {
    const { store } = fakeStore({ 'x/a.pdf': Buffer.from('%PDF') });
    await assert.rejects(
      runCrossBeamFlow(
        { ...IDS, files: [{ filename: 'a.pdf', storage_path: 'x/a.pdf', file_type: 'plan-binder' }], flowType: 'city-review', city: 'Placentia' },
        { client: new SpyClient() as Client, store: store as any },
      ),
      /No plan pages/,
    );
  });
});
