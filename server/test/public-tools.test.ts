import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';

const { detectInjection } = await import('../src/otari/guardrail-service.js');
const { reachableGuardrailUrl, reachableMcpUrl } = await import('../src/otari/public-urls.js');
const { guardrailsField } = await import('../src/otari/runner.js');
const { INJECTION_TEST_LINE } = await import('../src/otari/prompts.js');
const { createPublicToolsApp } = await import('../src/public-tools.js');
const { parseTelemetry, summarizeTelemetry, LOCAL_WEBHOOKS_LABEL } = await import('../../frontend/lib/otari-telemetry.js');

const ENV_KEYS = ['OTARI_PUBLIC_TOOLS_URL', 'OTARI_GUARDRAIL_URL', 'OTARI_MCP_PUBLIC_URL', 'MCP_ADU_LAW_TOKEN'];
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

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createPublicToolsApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('guardrail service', () => {
  it('flags the injection line the demo adds, and passes an ordinary corrections letter', () => {
    const flagged = detectInjection(`Corrections letter for a project in Placentia.\n\n${INJECTION_TEST_LINE}`);
    assert.equal(flagged.valid, false);
    assert.match(flagged.explanation ?? '', /override-instructions/);
    for (const text of [
      'Corrections letter for a project in Placentia. Provide water, sewer and gas connection details on Sheet A1.',
      'Show the previous permit number on the title sheet and follow the instructions on the handout.',
      'Revise the rear setback dimension to 4 ft per PMC 23.73.060.',
    ]) {
      assert.equal(detectInjection(text).valid, true, text);
    }
  });

  it('speaks the documented contract on both paths, and refuses other profiles', async () => {
    await withServer(async (base) => {
      for (const path of ['/api/guardrails/check', '/api/guardrails/check/validate']) {
        const res = await post(`${base}${path}`, { profile: 'prompt-injection', input_text: INJECTION_TEST_LINE, validate_kwargs: {} });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.profile, 'prompt-injection');
        assert.equal(body.result.valid, false);
        assert.equal(typeof body.result.score, 'number');
      }
      assert.equal((await post(`${base}/api/guardrails/check`, { profile: 'pii', input_text: 'x' })).status, 404);
      assert.equal((await post(`${base}/api/guardrails/check`, { input_text: 'x' })).status, 400);
      const profiles = await (await fetch(`${base}/api/guardrails/check/profiles`)).json();
      assert.deepEqual(profiles.map((p: { name: string }) => p.name), ['prompt-injection']);
    });
  });
});

describe('gateway-facing listener', () => {
  it('serves MCP and the guardrail, and nothing that spends money or reads projects', async () => {
    await withServer(async (base) => {
      const init = await post(`${base}/api/mcp/adu-law`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      assert.equal((await init.json()).result.serverInfo.name, 'structura-adu-law');
      for (const path of ['/generate', '/extract', '/api/otari/demo', '/api/otari/traces/x']) {
        assert.equal((await post(`${base}${path}`, {})).status, 404, path);
      }
    });
  });
});

describe('public URLs', () => {
  it('derives both URLs from one public base, and ignores localhost', () => {
    assert.equal(reachableMcpUrl(), null);
    assert.equal(reachableGuardrailUrl(), null);
    process.env.OTARI_PUBLIC_TOOLS_URL = 'http://localhost:8090';
    assert.equal(reachableMcpUrl(), null);
    assert.equal(reachableGuardrailUrl(), null);
    process.env.OTARI_PUBLIC_TOOLS_URL = 'https://abc.trycloudflare.com/';
    assert.equal(reachableMcpUrl(), 'https://abc.trycloudflare.com/api/mcp/adu-law');
    assert.equal(reachableGuardrailUrl(), 'https://abc.trycloudflare.com/api/guardrails/check');
    process.env.OTARI_GUARDRAIL_URL = 'https://guard.example.com/check';
    assert.equal(reachableGuardrailUrl(), 'https://guard.example.com/check');
  });

  it('requires https for the guardrail URL', () => {
    process.env.OTARI_PUBLIC_TOOLS_URL = 'http://abc.example.com';
    assert.equal(reachableGuardrailUrl(), null);
    assert.equal(reachableMcpUrl(), 'http://abc.example.com/api/mcp/adu-law');
  });

  it('puts the URL on the guardrail entry only when the gateway can reach it', () => {
    assert.deepEqual(guardrailsField({ simulateGuardrailBlock: true }), [{ profile: 'prompt-injection', mode: 'block', on_unavailable: 'monitor' }]);
    process.env.OTARI_PUBLIC_TOOLS_URL = 'https://abc.trycloudflare.com';
    assert.deepEqual(guardrailsField({}), [{
      profile: 'prompt-injection', mode: 'monitor', on_unavailable: 'monitor', url: 'https://abc.trycloudflare.com/api/guardrails/check',
    }]);
  });
});

describe('Inspector webhook status', () => {
  const event = (publicWebhooks?: { mcp: boolean; guardrail: boolean }) => parseTelemetry([{
    id: 1,
    content: `[OTARI_TELEMETRY] ${JSON.stringify({ role: 'drafter', stage: 'draft-analysis', model: 'm', status: 200, costUsd: 0, ...(publicWebhooks ? { publicWebhooks } : {}) })}`,
  }]);

  it('names the localhost fallback, the public case and the mixed case, and says nothing for old events', () => {
    assert.equal(summarizeTelemetry(event({ mcp: false, guardrail: false })).webhooks?.label, LOCAL_WEBHOOKS_LABEL);
    assert.equal(LOCAL_WEBHOOKS_LABEL, 'MCP & Guardrail Webhooks: Localhost Fallback Active (Direct Skill Injection)');
    const all = summarizeTelemetry(event({ mcp: true, guardrail: true })).webhooks;
    assert.equal(all?.public, true);
    assert.match(all?.detail ?? '', /MCP: called by the gateway · Guardrail: called by the gateway/);
    assert.match(summarizeTelemetry(event({ mcp: true, guardrail: false })).webhooks?.detail ?? '', /Guardrail: not reachable/);
    assert.equal(summarizeTelemetry(event()).webhooks, null);
  });
});
