/**
 * Offline stand-in for the Otari gateway, used by OtariClient in simulation mode.
 *
 * It returns real `Response` objects, so the client's normal parsing runs. Every
 * document it produces is visibly labelled and never contains real analysis.
 */

import { randomUUID } from 'node:crypto';

export type SimStage =
  | 'extract-corrections'
  | 'extract-sheets'
  | 'research'
  | 'spatial-compute'
  | 'spatial-verify'
  | 'draft-analysis'
  | 'draft-review'
  | 'draft-response';

export const SIMULATED_BANNER =
  '> **SIMULATED OUTPUT.** Produced by Otari demo simulation without calling a model. Do not submit it to a building department.\n\n';

/** Gateway failures the demo controls can reproduce without a real outage or spent key. */
export type SimScenario = 'primary-down' | 'gateway-failover' | 'budget-exceeded';

const SIM_CONTAINER_ID = 'ctr_otari_9f8a7b';
const SIM_DEFAULT_MODEL = 'openai/gpt-oss-120b';
const SIM_ADDRESS = 'SIMULATED, 123 Example St';

export function fileBlock(name: string, content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return `<file name="${name}">\n${text}\n</file>`;
}

const SIM_ITEMS = [
  { item_number: '1', section: 'Simulated Comments', description: 'Simulated: state the side setback on the site plan.', referenced_codes: ['Gov. Code § 66314(d)(7)'], referenced_sheets: ['site plan'], original_wording: 'SIMULATED correction wording, item 1.', severity_hint: 'important' },
  { item_number: '2', section: 'Simulated Comments', description: 'Simulated: confirm the existing sewer line size.', referenced_codes: ['CPC Table 702.1'], referenced_sheets: ['site plan'], original_wording: 'SIMULATED correction wording, item 2.', severity_hint: 'minor' },
];

function stageText(stage: SimStage | undefined): string {
  switch (stage) {
    case 'extract-corrections':
      return fileBlock('corrections_parsed.json', {
        simulated: true,
        project: { address: SIM_ADDRESS, city: 'Simulated', state: 'CA', permit_number: 'SIM-0001', project_type: 'Simulated detached ADU', review_round: 'Simulated', reviewer: 'Simulated', date: '2026-01-01' },
        items: SIM_ITEMS,
        deadline: null,
        total_items: SIM_ITEMS.length,
        code_references_summary: ['Gov. Code § 66314(d)(7)', 'CPC Table 702.1'],
      });
    case 'extract-sheets':
      return fileBlock('sheet_observations.json', {
        simulated: true,
        sheets: [{ page: 1, sheet_id: 'SIM-1', sheet_title: 'Simulated sheet', discipline: 'Simulated', observations: ['Simulated: no plan sheet was read.'], measurements: { lot_area_sqft: 6000, adu_area_sqft: 700, side_setback_ft: 4, rear_setback_ft: 4 } }],
      });
    case 'research':
      return fileBlock('city_research_findings.json', { simulated: true, sources: [], findings: [{ topic: 'Simulated', rule: 'Simulated: no web research was performed.', citation: null }] });
    case 'spatial-compute':
    case 'spatial-verify':
      return fileBlock('spatial_analysis.json', { simulated: true, checks: [{ check: 'side_setback', measured: 4, limit: 4, unit: 'ft', result: 'simulated' }], code_executed: true });
    case 'draft-analysis':
      return [
        fileBlock('state_law_findings.json', { simulated: true, findings: [] }),
        fileBlock('corrections_categorized.json', { simulated: true, items: SIM_ITEMS.map((item) => ({ ...item, category: 'NEEDS_CONTRACTOR_INPUT' })) }),
        fileBlock('contractor_questions.json', {
          simulated: true,
          summary: { total_items: 2, auto_fixable: 0, needs_contractor_input: 2, needs_professional: 0 },
          question_groups: [{
            correction_item_id: '2',
            item_summary: 'Simulated: sewer line size',
            category: 'NEEDS_CONTRACTOR_INPUT',
            research_context: 'Simulated context.',
            questions: [
              { question_id: 'q_2_0', question_text: '[SIMULATED] What is the size of the existing sewer line?', question_type: 'choice', options: ['3" ABS', '4" ABS'], context: 'Simulated context.' },
              { question_id: 'q_2_1', question_text: '[SIMULATED] Describe the proposed connection.', question_type: 'text' },
            ],
          }],
        }),
      ].join('\n');
    case 'draft-review':
      return [
        fileBlock('draft_corrections.md', `${SIMULATED_BANNER}# Draft Corrections Letter\n\n1. Simulated correction item. [REVIEWER: simulated]`),
        fileBlock('draft_corrections.json', { simulated: true, items: [] }),
        fileBlock('review_summary.json', { simulated: true, total_items: 1 }),
      ].join('\n');
    case 'draft-response':
      return [
        fileBlock('response_letter.md', `${SIMULATED_BANNER}# Response to Plan Check Comments\n\nSimulated response letter.`),
        fileBlock('professional_scope.md', `${SIMULATED_BANNER}# Professional Scope of Work\n\nSimulated scope.`),
        fileBlock('corrections_report.md', `${SIMULATED_BANNER}# Corrections Analysis Report\n\nSimulated report.`),
        fileBlock('sheet_annotations.json', { simulated: true, sheets: [] }),
      ].join('\n');
    default:
      return 'Simulated response.';
  }
}

interface SimRequest {
  method: string;
  path: string;
  body?: unknown;
  stage?: SimStage;
  scenario?: SimScenario;
  /** Hybrid replay: answer with this recorded text, no tool activity and no cost. */
  recordedText?: string;
}

type SimBody = {
  model?: string;
  tools?: Array<{ type?: string; name?: string; container?: unknown }>;
  guardrails?: Array<{ profile?: string; mode?: string }>;
  mcp_servers?: Array<{ name?: string }>;
  input?: unknown;
};

export function simulateOtariResponse(request: SimRequest): Response {
  const body = (request.body ?? {}) as SimBody;
  const model = body.model ?? SIM_DEFAULT_MODEL;
  const isFallback = request.scenario === 'gateway-failover';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Otari-Simulated': 'true',
    'Otari-Request-ID': `sim_${randomUUID()}`,
    'Otari-Provider': 'mozilla-ai',
    'Otari-Model': model,
    'Otari-Fallback': String(isFallback),
    'Otari-Attempt-Count': isFallback ? '2' : '1',
  };

  if (request.scenario === 'budget-exceeded') {
    // Documented shape of a per-key ceiling refusal.
    headers['Otari-Error-Code'] = 'budget_exceeded';
    headers['Otari-Budget-Scope'] = 'api_token';
    return new Response(JSON.stringify({ detail: 'API key has exceeded budget limit (simulated)', code: 'budget_exceeded' }), { status: 403, headers });
  }
  if (request.scenario === 'primary-down') {
    headers['Otari-Error-Code'] = 'provider_unavailable';
    return new Response(JSON.stringify({ detail: `Provider for ${model} is unavailable (simulated)`, code: 'provider_unavailable' }), { status: 503, headers });
  }

  if (request.method === 'GET') {
    return new Response(JSON.stringify({ items: [], has_more: false }), { status: 200, headers });
  }

  if (body.guardrails?.length) {
    const blocking = body.guardrails.some((g) => g.mode === 'block');
    headers['Otari-Guardrails'] = JSON.stringify(
      body.guardrails.map((g) => ({ profile: g.profile, mode: g.mode, valid: !blocking, score: blocking ? 0.997 : 0.02, status: 'evaluated' })),
    );
    if (blocking) {
      return new Response(
        JSON.stringify({ detail: 'Request blocked by guardrail: prompt-injection', code: 'guardrail_blocked' }),
        { status: 403, headers },
      );
    }
  }

  const codeTool = body.tools?.find((t) => t.type === 'otari_code_execution');
  if (codeTool) {
    const id = typeof codeTool.container === 'string' && codeTool.container !== 'auto' ? codeTool.container : SIM_CONTAINER_ID;
    headers['Otari-Container-Id'] = id;
    headers['X-Otari-Container-Id'] = id;
    headers['Otari-Container-Expires-At'] = new Date(Date.now() + 600_000).toISOString();
  }

  const recorded = request.recordedText !== undefined;
  const text = request.recordedText ?? stageText(request.stage);
  const input = 1200;
  const output = 400;

  if (request.path === '/chat/completions') {
    return new Response(JSON.stringify({
      id: `chatcmpl-sim-${randomUUID()}`,
      model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, cost_usd: recorded ? '0.000000' : '0.012000', pricing_source: recorded ? 'replay' : 'simulated' },
    }), { status: 200, headers });
  }

  const inputItems = Array.isArray(body.input) ? (body.input as Array<{ type?: string }>) : [];
  const offersLookup = body.tools?.some((t) => t.type === 'function');
  const answeredLookup = inputItems.some((item) => item.type === 'function_call_output');
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  const output_items: unknown[] = recorded
    ? [message]
    : offersLookup && !answeredLookup
    ? [{ type: 'function_call', call_id: 'call_sim_1', name: 'search_references', arguments: JSON.stringify({ query: 'side setback' }) }]
    : [
        ...(body.tools ?? []).filter((t) => t.type !== 'function').map((t) => ({ type: `${t.type}_call`, status: 'completed' })),
        ...(body.mcp_servers ?? []).map((s) => ({ type: 'mcp_call', server_label: s.name, name: 'search_references', status: 'completed' })),
        message,
      ];

  return new Response(JSON.stringify({
    id: `resp_sim_${randomUUID()}`,
    object: 'response',
    status: 'completed',
    model,
    output: output_items,
    // No cost on the researcher role, so the per-1k estimate path runs too.
    usage: recorded
      ? { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: '0.000000', pricing_source: 'replay' }
      : request.stage === 'research'
      ? { input_tokens: input, output_tokens: output, total_tokens: input + output }
      : { input_tokens: input, output_tokens: output, total_tokens: input + output, cost_usd: '0.012000', pricing_source: 'simulated' },
  }), { status: 200, headers });
}
