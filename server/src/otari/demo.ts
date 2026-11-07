/**
 * The Inspector's one-click judge demos. Each makes the smallest gateway call that shows
 * one control-plane behaviour, then writes ordinary telemetry to the project's stream.
 * None of them changes the project's status or writes outputs, so a demo can't disturb
 * a project's run.
 */

import { OTARI_MODELS } from '../utils/config.js';
import { insertMessage } from '../services/supabase.js';
import {
  isBudgetHold,
  isGuardrailBlock,
  otari,
  OtariClient,
  OtariError,
  type ChatCompletionResponse,
  type OtariReplay,
  type ResponsesResponse,
} from './client.js';
import { contractorKey } from './contractor-keys.js';
import { INJECTION_TEST_LINE } from './prompts.js';
import { attempt, guardrailsField, type RunContext, type RunnerStore } from './runner.js';

export const DEMO_SCENARIOS = ['guardrail-block', 'provider-failover', 'exhausted-key'] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export type DemoOutcome = 'blocked' | 'not-blocked' | 'failed-over' | 'held' | 'not-held' | 'error';

export interface DemoResult {
  scenario: DemoScenario;
  outcome: DemoOutcome;
  conversationId: string;
  simulated: boolean;
  status: number | null;
  code: string | null;
  message: string;
  /** Set when the gateway refused for lack of funds and this result is a replay. */
  replay: OtariReplay | null;
}

type DemoOutput = Omit<DemoResult, 'scenario' | 'conversationId' | 'simulated'>;
const REPLAY_NOTE = 'Replay: the gateway refused this call before it could run, so this shows how the result is displayed.';

const DEMO_MAX_TOKENS = 16;
const demoModel = () => process.env.OTARI_DEMO_MODEL || OTARI_MODELS.researcher[1];

function refusal(error: unknown): Pick<DemoResult, 'status' | 'code' | 'message' | 'replay'> {
  return {
    replay: error instanceof OtariError ? error.replay : null,
    status: error instanceof OtariError ? error.status : null,
    code: error instanceof OtariError ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

function demoContext(
  scenario: DemoScenario,
  projectId: string,
  client: OtariClient,
  store: Pick<RunnerStore, 'insertMessage'>,
  overrides: Partial<RunContext['options']> = {},
): RunContext {
  const apiKey = overrides.apiKey ?? contractorKey();
  return {
    deps: { client, store: store as RunnerStore },
    options: { files: [], flowType: 'corrections-analysis', city: '', projectId, userId: '', apiKey, ...overrides },
    runId: `crossbeam-demo-${projectId}-${Date.now()}`,
    simulated: client.isSimulating(apiKey),
    turns: 0,
    costUsd: 0,
    demoScenario: scenario,
    replayedCalls: 0,
  };
}

function miniChat(ctx: RunContext, role: 'extractor' | 'drafter', content: string, withGuardrail: boolean) {
  return attempt<ChatCompletionResponse>(ctx, role, 'extract-corrections', [{ model: demoModel() }], (candidate, signal) =>
    ctx.deps.client.chatCompletions({
      model: candidate.model,
      max_tokens: DEMO_MAX_TOKENS,
      messages: [{ role: 'user', content }],
      ...(withGuardrail ? { guardrails: guardrailsField(ctx.options) } : {}),
    }, {
      runId: ctx.runId,
      contractorKey: ctx.options.apiKey,
      signal,
      simStage: 'extract-corrections',
      simScenario: ctx.demoScenario === 'exhausted-key' ? 'budget-exceeded' : undefined,
      // This demo exists to show the refusal itself, so it's never replaced.
      allowReplay: ctx.demoScenario !== 'exhausted-key',
      // A 16-token call is quick, and only a non-streamed response carries Otari-Guardrails.
      stream: false,
    }),
  );
}

async function guardrailBlock(ctx: RunContext): Promise<DemoOutput> {
  try {
    const { result } = await miniChat(ctx, 'extractor', `Corrections letter text extracted from a PDF.\n\n${INJECTION_TEST_LINE}`, true);
    return {
      outcome: 'not-blocked',
      status: result.status,
      code: null,
      replay: result.replay,
      message: 'The gateway served this request: no block-mode guardrail refused it. Check that a prompt-injection guardrail is available on this workspace.',
    };
  } catch (error) {
    if (isGuardrailBlock(error)) {
      await ctx.deps.store.insertMessage(ctx.options.projectId, 'system', `[OTARI_GUARDRAIL] Demo payload blocked before reaching a provider: ${error.message}`);
      const blocked = refusal(error);
      return { outcome: 'blocked', ...blocked, message: blocked.replay ? `${REPLAY_NOTE} ${blocked.message}` : blocked.message };
    }
    return { outcome: isBudgetHold(error) ? 'held' : 'error', ...refusal(error) };
  }
}

async function providerFailover(ctx: RunContext): Promise<DemoOutput> {
  const [primary, backup] = OTARI_MODELS.researcher;
  // Live, the primary is replaced by an unroutable ID: a real outage can't be ordered up.
  const first = ctx.simulated ? primary : process.env.OTARI_DEMO_UNAVAILABLE_MODEL || 'openai/otari-demo-unavailable';
  try {
    const { result, candidate } = await attempt<ResponsesResponse>(ctx, 'researcher', 'research', [{ model: first }, { model: backup }], (option, signal) =>
      ctx.deps.client.responses({ model: option.model, input: 'Reply with OK.', max_output_tokens: DEMO_MAX_TOKENS }, {
        runId: ctx.runId,
        contractorKey: ctx.options.apiKey,
        signal,
        simStage: 'research',
        simScenario: option.model === first ? 'primary-down' : 'gateway-failover',
      }),
    );
    return {
      outcome: 'failed-over',
      status: result.status,
      code: null,
      replay: result.replay,
      message: result.replay
        ? `${first} really failed, and the client moved to ${candidate.model} on attempt 2. The gateway then returned ${result.replay.status} ${result.replay.code} for the backup, so its answer is a replay.`
        : `${first} failed, and ${candidate.model} served the request on attempt 2.`,
    };
  } catch (error) {
    return { outcome: isBudgetHold(error) ? 'held' : 'error', ...refusal(error) };
  }
}

async function exhaustedKey(ctx: RunContext): Promise<DemoOutput> {
  try {
    const { result } = await miniChat(ctx, 'drafter', 'Reply with OK.', false);
    return {
      outcome: 'not-held',
      status: result.status,
      code: null,
      replay: null,
      message: 'The gateway served this request, so this key still has budget. OTARI_EXHAUSTED_CONTRACTOR_KEY needs a key with no budget left.',
    };
  } catch (error) {
    return { outcome: isBudgetHold(error) ? 'held' : 'error', ...refusal(error) };
  }
}

export async function runDemoScenario(
  scenario: DemoScenario,
  projectId: string,
  deps: { client?: OtariClient; store?: Pick<RunnerStore, 'insertMessage'> } = {},
): Promise<DemoResult> {
  const client = deps.client ?? otari;
  const store = deps.store ?? { insertMessage };

  let ctx: RunContext;
  if (scenario === 'exhausted-key') {
    const exhausted = process.env.OTARI_EXHAUSTED_CONTRACTOR_KEY;
    const label = process.env.OTARI_EXHAUSTED_CONTRACTOR_KEY_LABEL || 'vk_contractor_exhausted_00';
    // Without a real spent key, this is a labelled simulation rather than a real refusal.
    ctx = exhausted && !client.isSimulating(exhausted)
      ? demoContext(scenario, projectId, client, store, { apiKey: exhausted, keyLabel: label })
      : demoContext(scenario, projectId, new OtariClient({ simulation: true }), store, { keyLabel: label });
  } else {
    ctx = demoContext(scenario, projectId, client, store, { simulateGuardrailBlock: scenario === 'guardrail-block' });
  }

  const run = { 'guardrail-block': guardrailBlock, 'provider-failover': providerFailover, 'exhausted-key': exhaustedKey }[scenario];
  return { scenario, conversationId: ctx.runId, simulated: ctx.simulated, ...await run(ctx) };
}
