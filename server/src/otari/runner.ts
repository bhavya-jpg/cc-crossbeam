/**
 * Runs a CrossBeam flow through the Otari gateway as a fixed 4-stage pipeline:
 *
 *   1 Extractor (chat + guardrail) -> 2 Researcher (web tools)
 *     -> 3 Analyst (code execution) -> 4 Drafter (law references)
 *
 * corrections-response only runs stage 4, because it reuses Phase 1's artifacts.
 * The rows written here are the frontend's contract: `messages` drive the live
 * stream, `outputs` drive the results view, and `projects.status` drives Realtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLOW_BUDGET,
  getCitySkillName,
  getFlowSkills,
  OTARI_COST_PER_1K,
  OTARI_MODELS,
  OTARI_REQUEST_TIMEOUT_MS,
  type InternalFlowType,
} from '../utils/config.js';
import {
  createOutputRecord,
  downloadProjectFile,
  insertMessage,
  replaceContractorQuestions,
  updateProjectStatus,
  type ContractorQuestionRow,
  type MessageRole,
  type ProjectStatus,
} from '../services/supabase.js';
import {
  guardrailVerdict,
  isBudgetHold,
  isGuardrailBlock,
  otari,
  OtariClient,
  OtariError,
  type ChatCompletionResponse,
  type OtariHeaders,
  type OtariReplay,
  type OtariResult,
  type OtariUsage,
  type ResponsesOutputItem,
  type ResponsesResponse,
} from './client.js';
import { contractorBudgetCapUsd, describeKey, type KeySource } from './contractor-keys.js';
import { ADU_LAW_TOOL_NAMES, ADU_LAW_TOOLS, callAduLawTool } from './mcp.js';
import { imageToDataUrl, prepareProjectFiles, type PageImage, type PreparedProject, type ProjectFileRecord } from './project-files.js';
import {
  DRAFT_ANALYSIS_PROMPT,
  DRAFT_RESPONSE_PROMPT,
  DRAFT_REVIEW_PROMPT,
  EXTRACT_CORRECTIONS_PROMPT,
  EXTRACT_SHEETS_PROMPT,
  INJECTION_TEST_LINE,
  RESEARCH_PROMPT,
  SPATIAL_COMPUTE_PROMPT,
  SPATIAL_VERIFY_PROMPT,
} from './prompts.js';
import type { SimStage } from './simulation.js';
import { readWorkflowDoc, selectReferences } from './skills.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

const MAX_PAGES = 30;
const PAGES_PER_BATCH = 5;
const BATCH_CONCURRENCY = 3;
const MAX_LOCAL_TOOL_ROUNDS = 4;
const MAX_ARTIFACT_CHARS = 60_000;

export interface RunFlowOptions {
  files: ProjectFileRecord[];
  flowType: InternalFlowType;
  city: string;
  address?: string;
  /** The contractor's Otari virtual key. Falls back to OTARI_API_KEY. */
  apiKey?: string | null;
  /** Unused: the Supabase client is configured from the environment. */
  supabaseUrl?: string;
  /** Unused: the Supabase client is configured from the environment. */
  supabaseKey?: string;
  projectId: string;
  userId: string;
  contractorAnswersJson?: string;
  phase1Artifacts?: Record<string, unknown>;
  /** Demo flag: runs the guardrail in block mode on a known injection string. */
  simulateGuardrailBlock?: boolean;
  /** Display name of apiKey. The key itself never appears in telemetry. */
  keyLabel?: string;
}

export interface RunnerStore {
  insertMessage(projectId: string, role: MessageRole, content: string): Promise<void>;
  updateProjectStatus(projectId: string, status: ProjectStatus, errorMessage?: string): Promise<void>;
  downloadProjectFile(storagePath: string): Promise<Buffer>;
  createOutputRecord(projectId: string, flowPhase: string, data: Record<string, unknown>): Promise<string>;
  replaceContractorQuestions(projectId: string, rows: ContractorQuestionRow[], outputId: string): Promise<void>;
}

export interface RunnerDeps {
  client: OtariClient;
  store: RunnerStore;
}

const defaultStore: RunnerStore = {
  insertMessage,
  updateProjectStatus,
  downloadProjectFile,
  createOutputRecord,
  replaceContractorQuestions,
};

type RoleName = 'extractor' | 'researcher' | 'analyst' | 'drafter';
type Artifacts = Record<string, unknown>;

export interface OtariTelemetry {
  role: RoleName;
  stage: SimStage;
  model: string | null;
  provider: string | null;
  requestId: string | null;
  fallback: boolean;
  attemptCount: number | null;
  guardrailsVerdict: string | null;
  containerId: string | null;
  costUsd: number;
  costSource: 'reported' | 'estimated';
  status: number;
  simulated: boolean;
  conversationId: string;
  /** 1 for the first model or tool set tried by this client, 2 for the next, and so on. */
  attempt: number;
  /** True only when the gateway itself reported a fallback in `Otari-Fallback`. */
  gatewayFallback: boolean;
  guardrailMode: 'monitor' | 'block' | null;
  blocked: boolean;
  budgetHold: boolean;
  budgetScope: string | null;
  errorCode: string | null;
  error: string | null;
  containerExpiresAt: string | null;
  keyLabel: string;
  keySource: KeySource;
  budgetCapUsd: number;
  demoScenario: string | null;
  /** Round trip to the gateway, in milliseconds. */
  latencyMs: number;
  /** Set when the gateway refused for lack of funds and recorded output was used. */
  replay: OtariReplay | null;
}

/** One way to attempt a call: tried in order until one is served. */
interface Candidate {
  model: string;
  tools?: unknown[];
}

export interface RunContext {
  deps: RunnerDeps;
  options: RunFlowOptions;
  runId: string;
  simulated: boolean;
  turns: number;
  costUsd: number;
  demoScenario: string | null;
  replayedCalls: number;
}

const log = (ctx: RunContext, role: MessageRole, content: string) =>
  ctx.deps.store.insertMessage(ctx.options.projectId, role, content);

// --- Cost and telemetry ---

export function costOfUsage(usage: OtariUsage | undefined): { costUsd: number; costSource: 'reported' | 'estimated' } {
  const reported = usage?.cost_usd === undefined ? Number.NaN : Number(usage.cost_usd);
  if (Number.isFinite(reported)) return { costUsd: reported, costSource: 'reported' };
  const input = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const output = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  return {
    costUsd: (input * OTARI_COST_PER_1K.input + output * OTARI_COST_PER_1K.output) / 1000,
    costSource: 'estimated',
  };
}

async function recordCall(
  ctx: RunContext,
  role: RoleName,
  stage: SimStage,
  candidate: Candidate,
  primaryModel: string,
  attemptNumber: number,
  call: { headers: OtariHeaders; status: number; usage?: OtariUsage; error?: OtariError; latencyMs: number; replay: OtariReplay | null },
): Promise<void> {
  const { costUsd, costSource } = costOfUsage(call.usage);
  const key = describeKey(ctx.options.apiKey, ctx.simulated, ctx.options.keyLabel);
  ctx.turns += 1;
  ctx.costUsd += costUsd;
  const telemetry: OtariTelemetry = {
    role,
    stage,
    model: call.headers.model ?? candidate.model,
    provider: call.headers.provider,
    requestId: call.headers.requestId,
    // Cross-model retries happen in this client, so the gateway's header can't report them.
    fallback: call.headers.fallback === 'true' || candidate.model !== primaryModel,
    attemptCount: call.headers.attemptCount,
    guardrailsVerdict: guardrailVerdict(call.headers.guardrails),
    containerId: call.headers.containerId,
    costUsd,
    costSource,
    status: call.status,
    simulated: ctx.simulated,
    conversationId: ctx.runId,
    attempt: attemptNumber,
    gatewayFallback: call.headers.fallback === 'true',
    guardrailMode: role === 'extractor' ? (ctx.options.simulateGuardrailBlock ? 'block' : 'monitor') : null,
    blocked: isGuardrailBlock(call.error),
    budgetHold: isBudgetHold(call.error),
    budgetScope: call.headers.raw['otari-budget-scope'] ?? null,
    errorCode: call.error?.code ?? null,
    error: call.error?.message.slice(0, 300) ?? null,
    containerExpiresAt: call.headers.containerExpires,
    keyLabel: key.label,
    keySource: key.source,
    budgetCapUsd: contractorBudgetCapUsd(),
    demoScenario: ctx.demoScenario,
    latencyMs: call.latencyMs,
    replay: call.replay,
  };
  await log(ctx, 'system', `[OTARI_TELEMETRY] ${JSON.stringify(telemetry)}`);

  if (call.replay) {
    ctx.replayedCalls += 1;
    if (ctx.replayedCalls === 1) {
      await log(ctx, 'system', `[OTARI_REPLAY] Otari returned ${call.replay.status} ${call.replay.code} (request ${call.replay.requestId}). Showing recorded output from an earlier run: no model is running.`);
    }
  }

  const budget = FLOW_BUDGET[ctx.options.flowType];
  if (ctx.costUsd > budget.maxBudgetUsd || ctx.turns > budget.maxTurns) {
    throw new Error(`Run budget exceeded: ${ctx.turns} calls, $${ctx.costUsd.toFixed(2)}`);
  }
}

/** Errors that another candidate can't fix: a bad key, a guardrail block, no funds, our own bugs. */
function isFatal(error: unknown): boolean {
  if (error instanceof OtariError) return error.status === 401 || isGuardrailBlock(error) || isBudgetHold(error);
  const name = (error as Error | undefined)?.name;
  return !(error instanceof TypeError || name === 'TimeoutError' || name === 'AbortError');
}

export async function attempt<T extends { usage?: OtariUsage }>(
  ctx: RunContext,
  role: RoleName,
  stage: SimStage,
  candidates: Candidate[],
  send: (candidate: Candidate, signal: AbortSignal) => Promise<OtariResult<T>>,
): Promise<{ result: OtariResult<T>; candidate: Candidate }> {
  const primaryModel = candidates[0].model;
  let lastError: unknown;
  for (const [index, candidate] of candidates.entries()) {
    try {
      const result = await send(candidate, AbortSignal.timeout(OTARI_REQUEST_TIMEOUT_MS));
      await recordCall(ctx, role, stage, candidate, primaryModel, index + 1, { headers: result.headers, status: result.status, usage: result.data.usage, latencyMs: result.latencyMs, replay: result.replay });
      return { result, candidate };
    } catch (error) {
      if (error instanceof OtariError) {
        await recordCall(ctx, role, stage, candidate, primaryModel, index + 1, { headers: error.headers, status: error.status, error, latencyMs: error.latencyMs, replay: error.replay });
      }
      if (isFatal(error)) throw error;
      lastError = error;
      const reason = error instanceof Error ? error.message : String(error);
      await log(ctx, 'system', `[OTARI] ${role}: ${candidate.model} failed (${reason.slice(0, 200)}). Trying the next option.`);
    }
  }
  throw lastError;
}

// --- Response parsing ---

export function responseText(data: ResponsesResponse): string {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  return data.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (item.content as Array<{ type?: string; text?: string }> | undefined) ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function stripCodeFence(text: string): string {
  return text.replace(/^```[a-z]*\s*\n/i, '').replace(/\n```\s*$/, '');
}

/** Reads `<file name="...">` blocks, keeping only expected names and parseable JSON. */
export function parseFiles(text: string, allowed: string[]): Artifacts {
  const files: Artifacts = {};
  for (const [, name, body] of text.matchAll(/<file name="([^"]+)">\s*([\s\S]*?)\s*<\/file>/g)) {
    if (!allowed.includes(name)) continue;
    if (name.endsWith('.json')) {
      try {
        files[name] = JSON.parse(stripCodeFence(body));
      } catch {
        // Left out, so the caller treats it as missing and retries.
      }
    } else {
      files[name] = stripCodeFence(body);
    }
  }
  return files;
}

/** Generates required files, asking once more if the first answer is incomplete. */
async function generateFiles(
  ctx: RunContext,
  role: RoleName,
  required: string[],
  generate: (retryNote: string) => Promise<string>,
): Promise<Artifacts> {
  let missing = required;
  for (let round = 0; round < 2; round += 1) {
    const retryNote = round === 0 ? '' : `\n\nYour previous answer was missing or had invalid JSON for: ${missing.join(', ')}. Return every required file.`;
    const files = parseFiles(await generate(retryNote), required);
    missing = required.filter((name) => !(name in files));
    if (missing.length === 0) return files;
    await log(ctx, 'system', `[OTARI] ${role}: incomplete answer, missing ${missing.join(', ')}`);
  }
  throw new Error(`${role} did not produce: ${missing.join(', ')}`);
}

async function logResponseActivity(ctx: RunContext, role: RoleName, output: ResponsesOutputItem[]): Promise<void> {
  for (const item of output) {
    if (item.type === 'message' || item.type === 'function_call') continue;
    const name = typeof item.name === 'string' ? `: ${item.name}` : '';
    await log(ctx, 'tool', `${role} ${item.type}${name}`);
  }
}

function asPromptJson(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, MAX_ARTIFACT_CHARS);
}

function inlineReferences(references: Array<{ id: string; text: string }>): string {
  return references.map(({ id, text }) => `--- ${id} ---\n${text}`).join('\n\n');
}

// --- Stage 1: Extractor and guardrail gate ---

export function guardrailsField(options: Pick<RunFlowOptions, 'simulateGuardrailBlock'>) {
  return [{
    profile: 'prompt-injection',
    mode: options.simulateGuardrailBlock ? 'block' : 'monitor',
    on_unavailable: 'monitor',
  }];
}

async function callExtractor(
  ctx: RunContext,
  stage: SimStage,
  instructions: string,
  userContent: unknown[],
): Promise<string> {
  const models = OTARI_MODELS.extractor;
  const { result } = await attempt<ChatCompletionResponse>(ctx, 'extractor', stage, models.map((model) => ({ model })), (candidate, signal) =>
    ctx.deps.client.chatCompletions({
      model: candidate.model,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: userContent },
      ],
      guardrails: guardrailsField(ctx.options),
    }, { runId: ctx.runId, contractorKey: ctx.options.apiKey, signal, simStage: stage }),
  );
  return result.data.choices[0]?.message?.content ?? '';
}

const imagePart = async (imagePath: string) => ({ type: 'image_url', image_url: { url: await imageToDataUrl(imagePath) } });

async function extractCorrections(ctx: RunContext, project: PreparedProject): Promise<Artifacts> {
  const { simulateGuardrailBlock } = ctx.options;
  const content: unknown[] = [{
    type: 'text',
    // Guardrails read text input, so any text layer from the letter goes in as text.
    text: [
      `Corrections letter for a project in ${ctx.options.city}.`,
      project.correctionText && `Text layer:\n${project.correctionText}`,
      simulateGuardrailBlock && INJECTION_TEST_LINE,
    ].filter(Boolean).join('\n\n'),
  }];
  content.push(...await Promise.all(project.correctionImages.map(imagePart)));

  return generateFiles(ctx, 'extractor', ['corrections_parsed.json'], (retryNote) =>
    callExtractor(ctx, 'extract-corrections', EXTRACT_CORRECTIONS_PROMPT + retryNote, content),
  );
}

async function extractSheets(ctx: RunContext, pages: PageImage[], includeInjectionLine: boolean): Promise<Artifacts> {
  if (pages.length > MAX_PAGES) {
    await log(ctx, 'system', `[OTARI] Plan set has ${pages.length} pages; reading the first ${MAX_PAGES}.`);
  }
  const selected = pages.slice(0, MAX_PAGES);
  const batches: PageImage[][] = [];
  for (let i = 0; i < selected.length; i += PAGES_PER_BATCH) batches.push(selected.slice(i, i + PAGES_PER_BATCH));

  const sheets: unknown[] = [];
  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
    const results = await Promise.all(batches.slice(i, i + BATCH_CONCURRENCY).map(async (batch, offset) => {
      const pageList = batch.map((page) => page.page).join(', ');
      const addLine = includeInjectionLine && i === 0 && offset === 0;
      const content: unknown[] = [
        { type: 'text', text: `Plan sheets in order, pages: ${pageList}.${addLine ? `\n\n${INJECTION_TEST_LINE}` : ''}` },
        ...await Promise.all(batch.map((page) => imagePart(page.path))),
      ];
      const files = await generateFiles(ctx, 'extractor', ['sheet_observations.json'], (retryNote) =>
        callExtractor(ctx, 'extract-sheets', EXTRACT_SHEETS_PROMPT + retryNote, content),
      );
      return (files['sheet_observations.json'] as { sheets?: unknown[] }).sheets ?? [];
    }));
    sheets.push(...results.flat());
  }
  return { 'sheet_observations.json': { sheets } };
}

function buildManifest(city: string, observations: Artifacts): unknown {
  // The bundled manifest describes the Placentia demo plan set, not other cities' plans.
  if (getCitySkillName(city) === 'placentia-adu') {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'b1-placentia-manifest.json'), 'utf-8'));
  }
  const { sheets = [] } = observations['sheet_observations.json'] as { sheets?: Array<Record<string, unknown>> };
  return {
    sheets: sheets.map(({ page, sheet_id, discipline, sheet_title }) => ({ page, sheet_id, discipline, sheet_title })),
  };
}

async function runExtractorStage(ctx: RunContext, project: PreparedProject): Promise<Artifacts> {
  const { flowType, city, simulateGuardrailBlock } = ctx.options;
  await log(ctx, 'system', `[OTARI 1/4] Extractor reading ${project.pages.length} plan pages (guardrail: ${simulateGuardrailBlock ? 'block' : 'monitor'})`);
  for (const warning of project.warnings) await log(ctx, 'system', `[OTARI] ${warning}`);

  const artifacts: Artifacts = {};
  const hasLetter = Boolean(project.correctionText) || project.correctionImages.length > 0;

  if (flowType === 'corrections-analysis') {
    if (!hasLetter) throw new Error('No readable corrections letter found for this project');
    Object.assign(artifacts, await extractCorrections(ctx, project));
  } else if (project.pages.length === 0) {
    throw new Error('No plan pages found for this project: PDF extraction may have failed');
  }

  Object.assign(artifacts, project.pages.length > 0
    ? await extractSheets(ctx, project.pages, flowType === 'city-review' && Boolean(simulateGuardrailBlock))
    : { 'sheet_observations.json': { sheets: [] } });

  artifacts['sheet-manifest.json'] = buildManifest(city, artifacts);
  await log(ctx, 'assistant', `Extractor finished: ${Object.keys(artifacts).join(', ')}`);
  return artifacts;
}

// --- Stage 2: City code researcher ---

async function runResearcherStage(ctx: RunContext, artifacts: Artifacts): Promise<Artifacts> {
  const { city, address } = ctx.options;
  await log(ctx, 'system', `[OTARI 2/4] Researcher looking up ${city} ADU rules`);

  const citySkill = getCitySkillName(city);
  const query = `${city} ${JSON.stringify(artifacts['corrections_parsed.json'] ?? artifacts['sheet_observations.json'])}`;
  const references = citySkill ? selectReferences(query, [citySkill], { limit: 4, maxCharsEach: 10_000 }) : [];

  const input = [
    `City: ${city}`,
    address && `Address: ${address}`,
    artifacts['corrections_parsed.json'] ? `Corrections:\n${asPromptJson(artifacts['corrections_parsed.json'])}` : `Plan observations:\n${asPromptJson(artifacts['sheet_observations.json'])}`,
    references.length > 0 && `Verified local references:\n${inlineReferences(references)}`,
  ].filter(Boolean).join('\n\n');

  const search = { type: 'otari_web_search', max_uses: 5 };
  // The live gateway rejects any field but `type` on this tool (400, seen 2026-11-04).
  const fetchTool = { type: 'otari_web_fetch' };
  const [primary, fallback] = OTARI_MODELS.researcher;
  // Web fetch is off by default on a deployment, so narrower tool sets are tried last.
  const candidates: Candidate[] = [[search, fetchTool], [search], []].flatMap((tools) => [
    { model: primary, tools },
    { model: fallback, tools },
  ]);

  const files = await generateFiles(ctx, 'researcher', ['city_research_findings.json'], async (retryNote) => {
    const { result, candidate } = await attempt<ResponsesResponse>(ctx, 'researcher', 'research', candidates, (option, signal) =>
      ctx.deps.client.responses({
        model: option.model,
        instructions: RESEARCH_PROMPT + retryNote,
        input,
        tools: option.tools,
        max_output_tokens: 8000,
      }, { runId: ctx.runId, contractorKey: ctx.options.apiKey, signal, simStage: 'research' }),
    );
    if (candidate.tools?.length === 0) await log(ctx, 'system', '[OTARI] Researcher ran without web tools; relying on local references only.');
    await logResponseActivity(ctx, 'researcher', result.data.output);
    return responseText(result.data);
  });

  await log(ctx, 'assistant', 'Researcher finished');
  return files;
}

// --- Stage 3: Spatial and setback analyst ---

async function runAnalystStage(ctx: RunContext, artifacts: Artifacts): Promise<Artifacts> {
  await log(ctx, 'system', '[OTARI 3/4] Analyst checking lot coverage, setbacks and fee thresholds in a code sandbox');

  const thresholds = selectReferences('setback height size lot coverage fee thresholds', ['california-adu'], { limit: 4, maxCharsEach: 6_000 });
  const facts = [
    `Plan observations:\n${asPromptJson(artifacts['sheet_observations.json'])}`,
    `City findings:\n${asPromptJson(artifacts['city_research_findings.json'])}`,
    `State thresholds:\n${inlineReferences(thresholds)}`,
  ].join('\n\n');

  const [primary, fallback] = OTARI_MODELS.analyst;
  const sendAnalyst = (stage: SimStage, instructions: string, input: string, candidates: Candidate[]) =>
    attempt<ResponsesResponse>(ctx, 'analyst', stage, candidates, (option, signal) =>
      ctx.deps.client.responses({
        model: option.model,
        instructions,
        input,
        tools: option.tools,
        max_output_tokens: 8000,
      }, { runId: ctx.runId, contractorKey: ctx.options.apiKey, signal, simStage: stage }),
    );
  const codeTool = (container: string) => [{ type: 'otari_code_execution', container }];

  let firstContainer: string | null = null;
  let firstRanCode = false;
  let servedBy = primary;
  const computed = await generateFiles(ctx, 'analyst', ['spatial_analysis.json'], async (retryNote) => {
    const { result, candidate } = await sendAnalyst('spatial-compute', SPATIAL_COMPUTE_PROMPT + retryNote, facts, [
      { model: primary, tools: codeTool('auto') },
      { model: fallback, tools: codeTool('auto') },
      { model: primary, tools: [] },
      { model: fallback, tools: [] },
    ]);
    firstContainer = result.headers.containerId;
    firstRanCode = Boolean(candidate.tools?.length) && !result.replay;
    servedBy = candidate.model;
    await logResponseActivity(ctx, 'analyst', result.data.output);
    return responseText(result.data);
  });

  let secondContainer: string | null = null;
  let secondRanCode = false;
  const verifyInput = `${facts}\n\nEarlier analysis:\n${asPromptJson(computed['spatial_analysis.json'])}`;
  const verified = await generateFiles(ctx, 'analyst', ['spatial_analysis.json'], async (retryNote) => {
    // Stay on the model that served turn 1, in case the other one is unavailable.
    const otherModel = servedBy === primary ? fallback : primary;
    const candidates: Candidate[] = [
      ...(firstContainer ? [{ model: servedBy, tools: codeTool(firstContainer) }] : []),
      // A held container can expire or be refused, so a new one is the next option.
      { model: servedBy, tools: codeTool('auto') },
      { model: otherModel, tools: codeTool('auto') },
      { model: servedBy, tools: [] },
    ];
    const { result, candidate } = await sendAnalyst('spatial-verify', SPATIAL_VERIFY_PROMPT + retryNote, verifyInput, candidates);
    secondContainer = result.headers.containerId;
    secondRanCode = Boolean(candidate.tools?.length) && !result.replay;
    await logResponseActivity(ctx, 'analyst', result.data.output);
    return responseText(result.data);
  });

  const containerReused = Boolean(firstContainer) && firstContainer === secondContainer;
  await log(ctx, 'assistant', containerReused
    ? `Analyst finished; reused sandbox ${firstContainer} across both turns`
    : 'Analyst finished; the sandbox was not reused across turns');

  return {
    'spatial_analysis.json': {
      ...(verified['spatial_analysis.json'] as Record<string, unknown>),
      execution: {
        code_executed: firstRanCode || secondRanCode,
        container_id_turn_1: firstContainer,
        container_id_turn_2: secondContainer,
        container_reused: containerReused,
      },
    },
  };
}

// --- Stage 4: Law and deliverable drafter ---

const DRAFT_PLANS: Record<InternalFlowType, { stage: SimStage; prompt: string; files: string[]; workflowDoc: string }> = {
  'corrections-analysis': {
    stage: 'draft-analysis',
    prompt: DRAFT_ANALYSIS_PROMPT,
    files: ['state_law_findings.json', 'corrections_categorized.json', 'contractor_questions.json'],
    workflowDoc: 'adu-corrections-flow/references/output-schemas.md',
  },
  'city-review': {
    stage: 'draft-review',
    prompt: DRAFT_REVIEW_PROMPT,
    files: ['draft_corrections.md', 'draft_corrections.json', 'review_summary.json'],
    workflowDoc: 'adu-plan-review/SKILL.md',
  },
  'corrections-response': {
    stage: 'draft-response',
    prompt: DRAFT_RESPONSE_PROMPT,
    files: ['corrections_report.md', 'professional_scope.md', 'response_letter.md', 'sheet_annotations.json'],
    workflowDoc: 'adu-corrections-complete/SKILL.md',
  },
};

/** The MCP URL, if the gateway could reach it. Docs require https when a token is sent. */
export function reachableMcpUrl(): string | null {
  const configured = process.env.OTARI_MCP_PUBLIC_URL;
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.local');
  if (isLocal) return null;
  if (process.env.MCP_ADU_LAW_TOKEN && url.protocol !== 'https:') return null;
  return configured;
}

async function draftViaManagedMcp(
  ctx: RunContext,
  stage: SimStage,
  instructions: string,
  input: string,
  mcpUrl: string,
): Promise<string> {
  const token = process.env.MCP_ADU_LAW_TOKEN;
  const { result } = await attempt<ResponsesResponse>(ctx, 'drafter', stage, OTARI_MODELS.drafter.map((model) => ({ model })), (candidate, signal) =>
    ctx.deps.client.responses({
      model: candidate.model,
      instructions,
      input,
      mcp_servers: [{
        name: 'adu_law',
        url: mcpUrl,
        ...(token ? { authorization_token: token } : {}),
        purpose_hint: 'California ADU law and onboarded-city reference documents',
        allowed_tools: ADU_LAW_TOOL_NAMES,
      }],
      max_tool_iterations: MAX_LOCAL_TOOL_ROUNDS,
      max_output_tokens: 16000,
    }, { runId: ctx.runId, contractorKey: ctx.options.apiKey, signal, simStage: stage }),
  );
  await logResponseActivity(ctx, 'drafter', result.data.output);
  return responseText(result.data);
}

async function draftViaLocalTools(ctx: RunContext, stage: SimStage, instructions: string, input: string): Promise<string> {
  const functionTools = ADU_LAW_TOOLS.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, parameters: inputSchema }));
  const conversation: unknown[] = [{ role: 'user', content: input }];

  for (let round = 0; round <= MAX_LOCAL_TOOL_ROUNDS; round += 1) {
    // The last round offers no tools, so the model has to answer.
    const tools = round < MAX_LOCAL_TOOL_ROUNDS ? functionTools : [];
    const { result } = await attempt<ResponsesResponse>(ctx, 'drafter', stage, OTARI_MODELS.drafter.map((model) => ({ model })), (candidate, signal) =>
      ctx.deps.client.responses({
        model: candidate.model,
        instructions,
        input: conversation,
        tools,
        max_output_tokens: 16000,
      }, { runId: ctx.runId, contractorKey: ctx.options.apiKey, signal, simStage: stage }),
    );
    await logResponseActivity(ctx, 'drafter', result.data.output);

    const calls = result.data.output.filter((item) => item.type === 'function_call');
    if (calls.length === 0) return responseText(result.data);

    conversation.push(...calls);
    for (const call of calls) {
      const name = String(call.name);
      await log(ctx, 'tool', `drafter ${name}`);
      let args: unknown = {};
      try {
        args = JSON.parse(String(call.arguments ?? '{}'));
      } catch {
        // callAduLawTool reports the invalid arguments back to the model.
      }
      conversation.push({ type: 'function_call_output', call_id: call.call_id, output: callAduLawTool(name, args).text });
    }
  }
  return '';
}

async function runDrafterStage(ctx: RunContext, artifacts: Artifacts): Promise<Artifacts> {
  const { flowType, city, address, contractorAnswersJson } = ctx.options;
  const plan = DRAFT_PLANS[flowType];
  await log(ctx, 'system', `[OTARI 4/4] Drafter preparing ${plan.files.join(', ')}`);

  const citySkill = getCitySkillName(city);
  const lawSkills = ['california-adu', ...(citySkill ? [citySkill] : [])];
  const query = JSON.stringify(artifacts['corrections_categorized.json'] ?? artifacts['corrections_parsed.json'] ?? artifacts['sheet_observations.json'] ?? '');
  const references = [
    { id: 'california-adu/SKILL', text: readWorkflowDoc('california-adu/SKILL.md', 12_000) },
    ...selectReferences(query, lawSkills, { limit: 6, maxCharsEach: 10_000 }),
  ];

  const instructions = `${plan.prompt}\n\nWorkflow reference:\n${readWorkflowDoc(plan.workflowDoc, 16_000)}`;
  const input = [
    `City: ${city}`,
    address && `Address: ${address}`,
    ...Object.entries(artifacts).map(([name, value]) => `${name}:\n${asPromptJson(value)}`),
    contractorAnswersJson && `contractor_answers.json:\n${contractorAnswersJson}`,
    `Law references:\n${inlineReferences(references)}`,
  ].filter(Boolean).join('\n\n');

  const mcpUrl = reachableMcpUrl();
  await log(ctx, 'system', mcpUrl ? '[OTARI] Drafter using the ADU law MCP server through the gateway' : '[OTARI] Drafter using the local law-reference tool loop');

  const files = await generateFiles(ctx, 'drafter', plan.files, async (retryNote) => {
    const prompt = instructions + retryNote;
    if (mcpUrl) {
      try {
        return await draftViaManagedMcp(ctx, plan.stage, prompt, input, mcpUrl);
      } catch (error) {
        if (isFatal(error)) throw error;
        await log(ctx, 'system', '[OTARI] Gateway could not use the MCP server; switching to the local tool loop.');
      }
    }
    return draftViaLocalTools(ctx, plan.stage, prompt, input);
  });

  await log(ctx, 'assistant', 'Drafter finished');
  return files;
}

// --- Persistence ---

const VALID_QUESTION_TYPES = new Set(['text', 'number', 'choice', 'measurement']);

/** Flattens contractor_questions.json into rows that satisfy the table's CHECK constraint. */
export function toQuestionRows(questions: unknown, projectId: string): ContractorQuestionRow[] {
  type RawQuestion = Record<string, unknown>;
  const root = (questions ?? {}) as { question_groups?: RawQuestion[]; questions?: RawQuestion[]; professional_items?: RawQuestion[] };

  const collected: Array<{ q: RawQuestion; group?: RawQuestion }> = [];
  if (Array.isArray(questions)) collected.push(...(questions as RawQuestion[]).map((q) => ({ q })));
  for (const q of root.questions ?? []) collected.push({ q });
  for (const group of root.question_groups ?? []) {
    for (const q of (group.questions as RawQuestion[] | undefined) ?? []) collected.push({ q, group });
  }
  for (const group of root.professional_items ?? []) {
    if (group.contractor_question) collected.push({ q: group.contractor_question as RawQuestion, group });
  }

  return collected.map(({ q, group }, index) => {
    const declared = String(q.question_type ?? q.type ?? 'text');
    const options = declared === 'yes_no' ? ['Yes', 'No'] : Array.isArray(q.options) && q.options.length > 0 ? q.options.map(String) : null;
    const questionType = options ? 'choice' : VALID_QUESTION_TYPES.has(declared) && declared !== 'choice' ? declared : 'text';
    return {
      project_id: projectId,
      question_key: String(q.question_id ?? q.key ?? q.question_key ?? q.id ?? `q_${index}`),
      question_text: String(q.question_text ?? q.question ?? q.text ?? q.context ?? ''),
      question_type: questionType,
      options,
      context: (q.context ?? q.why ?? group?.research_context ?? null) as string | null,
      correction_item_id: (q.correction_item_id ?? q.item_id ?? group?.correction_item_id ?? null) as string | null,
      is_answered: false,
    };
  });
}

function outputColumns(flowType: InternalFlowType, files: Artifacts): Record<string, unknown> {
  switch (flowType) {
    case 'city-review':
      return {
        corrections_letter_md: files['draft_corrections.md'] ?? null,
        review_checklist_json: files['draft_corrections.json'] ?? null,
      };
    case 'corrections-analysis':
      return {
        corrections_analysis_json: files['corrections_categorized.json'] ?? null,
        contractor_questions_json: files['contractor_questions.json'] ?? null,
      };
    case 'corrections-response':
      return {
        response_letter_md: files['response_letter.md'] ?? null,
        professional_scope_md: files['professional_scope.md'] ?? null,
        corrections_report_md: files['corrections_report.md'] ?? null,
      };
  }
}

const FLOW_PHASE: Record<InternalFlowType, string> = {
  'city-review': 'review',
  'corrections-analysis': 'analysis',
  'corrections-response': 'response',
};

// --- Main export ---

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export async function runCrossBeamFlow(options: RunFlowOptions, overrides: Partial<RunnerDeps> = {}): Promise<void> {
  const deps: RunnerDeps = { client: overrides.client ?? otari, store: overrides.store ?? defaultStore };
  const startedAt = Date.now();
  const { flowType, projectId } = options;
  const ctx: RunContext = {
    deps,
    options,
    runId: `crossbeam-${projectId}-${startedAt}`,
    simulated: deps.client.isSimulating(options.apiKey),
    turns: 0,
    costUsd: 0,
    demoScenario: null,
    replayedCalls: 0,
  };
  let project: PreparedProject | null = null;

  try {
    await log(ctx, 'system', `[OTARI] Run ${ctx.runId} started (skills: ${getFlowSkills(flowType, options.city).join(', ')})`);
    if (ctx.simulated) {
      await log(ctx, 'system', '[OTARI_SIMULATION] Demo simulation is active: no model is being called and all outputs are placeholders.');
    }

    let artifacts: Artifacts;
    if (flowType === 'corrections-response') {
      if (!options.phase1Artifacts) throw new Error('Phase 1 analysis artifacts not found for this project');
      await log(ctx, 'system', '[OTARI] Reusing Phase 1 artifacts for stages 1-3');
      artifacts = { ...options.phase1Artifacts };
    } else {
      project = await prepareProjectFiles(options.files, deps.store.downloadProjectFile);
      artifacts = await runExtractorStage(ctx, project);
      Object.assign(artifacts, await runResearcherStage(ctx, artifacts));
      Object.assign(artifacts, await runAnalystStage(ctx, artifacts));
    }

    const drafted = await runDrafterStage(ctx, artifacts);
    const allFiles = { ...artifacts, ...drafted };

    await log(ctx, 'system', 'Processing outputs...');
    const outputId = await deps.store.createOutputRecord(projectId, FLOW_PHASE[flowType], {
      raw_artifacts: ctx.replayedCalls ? { ...allFiles, 'replay.json': { replayed_calls: ctx.replayedCalls, note: 'No model produced this run: the gateway returned 402 insufficient_funds.' } } : allFiles,
      agent_cost_usd: ctx.costUsd,
      agent_turns: ctx.turns,
      agent_duration_ms: Date.now() - startedAt,
      ...outputColumns(flowType, allFiles),
    });

    if (flowType === 'corrections-analysis') {
      await deps.store.replaceContractorQuestions(projectId, toQuestionRows(allFiles['contractor_questions.json'], projectId), outputId);
    }

    await log(ctx, 'system', `Run summary: ${ctx.turns} Otari calls, $${ctx.costUsd.toFixed(4)}${ctx.replayedCalls ? `, ${ctx.replayedCalls} replayed from a recorded run` : ''}`);
    // AgentStream refreshes the page on a message starting "Completed in ".
    await log(ctx, 'system', `Completed in ${formatDuration(Date.now() - startedAt)}`);
    await deps.store.updateProjectStatus(projectId, flowType === 'corrections-analysis' ? 'awaiting-answers' : 'completed');
    await log(ctx, 'system', 'Processing complete');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(ctx, 'system', isGuardrailBlock(error)
      ? `[OTARI_GUARDRAIL] Blocked before reaching a provider: ${message}`
      : isBudgetHold(error)
        ? `[OTARI_BUDGET] Run held, the gateway refused to spend: ${message}`
        : `Agent error: ${message}`);
    // The route's handler sets the project's failed status from this error.
    throw error;
  } finally {
    project?.cleanup();
  }
}
