/**
 * Typed client for the Otari.ai LLM gateway.
 *
 * Every call:
 *  - authenticates with the contractor's virtual key, or OTARI_API_KEY if none
 *  - tags generation requests with `Otari-Conversation-Id: <run_id>`
 *  - returns the gateway's control-plane response headers, on errors too
 *
 * Env: OTARI_API_KEY, OTARI_MASTER_KEY (traces only), OTARI_BASE_URL (optional),
 *      OTARI_DEMO_SIMULATION ('true' forces simulation, 'false' forbids it).
 *
 * With no key available the client simulates the gateway, except in production,
 * where it fails instead so a misconfigured deploy can't write placeholder
 * permit documents. Simulated results are flagged `simulated: true`.
 *
 * OTARI_HYBRID_FALLBACK=true (outside production) still calls the gateway, and answers
 * a real `402 insufficient_funds` with recorded output, flagged in `replay`. Once the
 * account has funds the gateway serves the call and the flag never appears.
 *
 * Generation calls stream by default, because otari.ai's CDN ends a request that sends
 * nothing for about 30 seconds; see stream.ts. Pass `stream: false` to get the
 * `Otari-Guardrails` header, which only non-streamed responses carry.
 *
 * Payload types stay open, and every Otari header is also kept verbatim in `headers.raw`.
 */

import { replayResponse } from './replay.js';
import { simulateOtariResponse, type SimScenario, type SimStage } from './simulation.js';
import { collectChatStream, collectResponsesStream, StreamFailure } from './stream.js';

export const OTARI_DEFAULT_BASE_URL = 'https://otari.ai/api/v1';

// --- Control-plane headers ---

export interface OtariHeaders {
  requestId: string | null;
  provider: string | null;
  model: string | null;
  fallback: string | null;
  attemptCount: number | null;
  guardrails: string | null;
  containerId: string | null;
  containerExpires: string | null;
  /** Every `otari-*` and `x-otari-*` header, with lowercased names. */
  raw: Record<string, string>;
}

export function parseOtariHeaders(headers: Headers): OtariHeaders {
  const raw: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('otari-') || lower.startsWith('x-otari-')) {
      raw[lower] = value;
    }
  });

  const attemptCount = Number.parseInt(raw['otari-attempt-count'] ?? '', 10);
  // Docs name these without the `X-` prefix; both spellings are accepted.
  const containerExpiresName = Object.keys(raw).find(
    (name) => name.startsWith('otari-container-expires') || name.startsWith('x-otari-container-expires'),
  );

  return {
    requestId: raw['otari-request-id'] ?? null,
    provider: raw['otari-provider'] ?? null,
    model: raw['otari-model'] ?? null,
    fallback: raw['otari-fallback'] ?? null,
    attemptCount: Number.isNaN(attemptCount) ? null : attemptCount,
    guardrails: raw['otari-guardrails'] ?? null,
    containerId: raw['otari-container-id'] ?? raw['x-otari-container-id'] ?? null,
    containerExpires: containerExpiresName ? raw[containerExpiresName] : null,
    raw,
  };
}

/**
 * Reduces the `Otari-Guardrails` header to one verdict. The documented value is a
 * JSON array of `{ profile, mode, valid, status, reason? }`; anything else is
 * returned unchanged.
 */
export function guardrailVerdict(header: string | null): string | null {
  if (!header) return null;
  let entries: unknown;
  try {
    entries = JSON.parse(header);
  } catch {
    return header;
  }
  if (!Array.isArray(entries)) return header;
  const typed = entries as Array<{ valid?: boolean | null; status?: string }>;
  if (typed.some((e) => e.valid === false)) return 'flagged';
  if (typed.some((e) => e.status === 'unavailable')) return 'unavailable';
  if (typed.some((e) => e.status === 'inconclusive')) return 'inconclusive';
  return typed.length > 0 ? 'passed' : null;
}

// --- Request and response types ---

/** The real gateway refusal behind a replayed result. */
export interface OtariReplay {
  requestId: string | null;
  status: number;
  code: string | null;
  latencyMs: number;
}

export interface OtariResult<T> {
  data: T;
  status: number;
  headers: OtariHeaders;
  simulated: boolean;
  /** Round trip to the gateway; 0 when simulated. */
  latencyMs: number;
  /** Set when the gateway refused for lack of funds and recorded output stands in. */
  replay: OtariReplay | null;
}

export interface OtariCallOptions {
  /** Per-contractor virtual key. Falls back to OTARI_API_KEY when empty. */
  contractorKey?: string | null;
  signal?: AbortSignal;
  /** Chooses the canned simulation response. Never sent to the gateway. */
  simStage?: SimStage;
  /** Makes the simulation reproduce a gateway failure. Never sent to the gateway. */
  simScenario?: SimScenario;
  /** False keeps a real funds refusal as an error, even in hybrid mode. */
  allowReplay?: boolean;
  /**
   * Generation calls stream unless this is false. A non-streamed call longer than about
   * 30 seconds is cut off by the CDN, but only it returns the `Otari-Guardrails` header.
   */
  stream?: boolean;
}

export interface OtariRunOptions extends OtariCallOptions {
  /** Sent as `Otari-Conversation-Id`, grouping all of a run's calls. */
  runId: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  [key: string]: unknown;
}

export interface OtariUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** Six-decimal USD string, present on priced responses. */
  cost_usd?: string;
  pricing_source?: string;
  [key: string]: unknown;
}

/** `stream` is set by the client (see OtariCallOptions.stream), not by callers. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: false;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: { role: string; content: string | null; [key: string]: unknown };
  }>;
  usage?: OtariUsage;
  [key: string]: unknown;
}

export interface ResponsesRequest {
  model: string;
  input: unknown;
  stream?: false;
  [key: string]: unknown;
}

export interface ResponsesOutputItem {
  type: string;
  [key: string]: unknown;
}

export interface ResponsesResponse {
  id: string;
  model?: string;
  status?: string;
  output: ResponsesOutputItem[];
  output_text?: string;
  usage?: OtariUsage;
  [key: string]: unknown;
}

export type TracesQuery = Record<string, string | number | boolean | undefined>;

export interface TraceSummary {
  trace_id: string;
  workspace_id: string;
  name: string | null;
  started_at: string;
  last_activity_at: string;
  step_count: number;
  span_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  [key: string]: unknown;
}

export interface TraceList {
  items: TraceSummary[];
  has_more: boolean;
}

// --- Errors ---

export class OtariError extends Error {
  readonly name = 'OtariError';

  constructor(
    message: string,
    readonly status: number,
    /** The `otari-error-code` header or body `code`, e.g. `invalid_request`. */
    readonly code: string | null,
    readonly body: unknown,
    readonly headers: OtariHeaders,
    readonly latencyMs: number = 0,
    readonly replay: OtariReplay | null = null,
  ) {
    super(message);
  }
}

/** True when a `block` guardrail refused the request (documented as a 403). */
export function isGuardrailBlock(error: unknown): error is OtariError {
  if (!(error instanceof OtariError) || error.status !== 403) return false;
  return (
    guardrailVerdict(error.headers.guardrails) === 'flagged' ||
    /guardrail/i.test(error.code ?? '') ||
    /guardrail/i.test(error.message)
  );
}

/**
 * True when the gateway refused to spend: `403 budget_exceeded` for a key or workspace
 * ceiling, `402 insufficient_funds` for an organization with no funds.
 */
export function isBudgetHold(error: unknown): error is OtariError {
  return error instanceof OtariError && (error.code === 'budget_exceeded' || error.code === 'insufficient_funds');
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const { detail, error } = body as { detail?: unknown; error?: { message?: unknown } };
    if (detail !== undefined) {
      return `Otari ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    }
    if (typeof error?.message === 'string') return `Otari ${status}: ${error.message}`;
  }
  if (typeof body === 'string' && /^\s*</.test(body)) {
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
    // An HTML page comes from the CDN in front of the gateway, not the gateway itself.
    return `Otari ${status}: non-JSON error page from the gateway's CDN${title ? ` (${title})` : ''}`;
  }
  return `Otari ${status}: ${typeof body === 'string' && body ? body : 'request failed'}`;
}

// --- Client ---

/** Off in production, where recorded output must never reach a real project. */
export function hybridFallbackEnabled(): boolean {
  return process.env.OTARI_HYBRID_FALLBACK === 'true' && process.env.NODE_ENV !== 'production';
}

export interface OtariClientConfig {
  baseUrl?: string;
  apiKey?: string;
  masterKey?: string;
  fetch?: typeof globalThis.fetch;
  /** Overrides the environment's choice of simulated or live mode. */
  simulation?: boolean;
}

export class OtariClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly masterKey?: string;
  private readonly simulation?: boolean;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: OtariClientConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env.OTARI_BASE_URL || OTARI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.masterKey = config.masterKey;
    this.simulation = config.simulation;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  /** Whether a call with this contractor key would be simulated. */
  isSimulating(contractorKey?: string | null): boolean {
    if (this.simulation !== undefined) return this.simulation;
    const flag = process.env.OTARI_DEMO_SIMULATION;
    if (flag === 'true') return true;
    if (flag === 'false' || process.env.NODE_ENV === 'production') return false;
    return !(contractorKey || this.apiKey || process.env.OTARI_API_KEY);
  }

  /** POST /responses */
  responses(body: ResponsesRequest, options: OtariRunOptions): Promise<OtariResult<ResponsesResponse>> {
    return this.request('POST', '/responses', options, body);
  }

  /** POST /chat/completions */
  chatCompletions(
    body: ChatCompletionRequest,
    options: OtariRunOptions,
  ): Promise<OtariResult<ChatCompletionResponse>> {
    return this.request('POST', '/chat/completions', options, body);
  }

  /**
   * GET /organizations/me/traces. Query parameters are passed through unchanged.
   * Sends OTARI_MASTER_KEY when set. The docs list this route for signed-in member
   * sessions, so API-key access may be refused; see OTARI_FRICTION_LOG.md.
   */
  listTraces(query: TracesQuery = {}, options: OtariCallOptions = {}): Promise<OtariResult<TraceList>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    const masterKey = this.masterKey || process.env.OTARI_MASTER_KEY;
    return this.request('GET', `/organizations/me/traces${search ? `?${search}` : ''}`, options, undefined, masterKey);
  }

  /** GET /organizations/me/traces/{id}. Same credential rules as listTraces. */
  getTrace(traceId: string, query: TracesQuery = {}, options: OtariCallOptions = {}): Promise<OtariResult<Record<string, unknown>>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    const masterKey = this.masterKey || process.env.OTARI_MASTER_KEY;
    return this.request('GET', `/organizations/me/traces/${encodeURIComponent(traceId)}${search ? `?${search}` : ''}`, options, undefined, masterKey);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: OtariCallOptions & { runId?: string },
    body?: unknown,
    preferredKey?: string,
  ): Promise<OtariResult<T>> {
    const simulated = this.isSimulating(options.contractorKey);
    let response: Response;
    let latencyMs = 0;
    let startedAt = 0;
    let replay: OtariReplay | null = null;
    const streamable = method === 'POST' && options.stream !== false && (path === '/chat/completions' || path === '/responses');

    if (simulated) {
      response = simulateOtariResponse({ method, path, body, stage: options.simStage, scenario: options.simScenario });
    } else {
      // Resolved per call so that importing this module never requires the env var.
      const key = preferredKey || options.contractorKey || this.apiKey || process.env.OTARI_API_KEY;
      if (!key) {
        throw new Error('Otari: no API key. Pass a contractor key or set OTARI_API_KEY.');
      }

      const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
      if (options.runId) headers['Otari-Conversation-Id'] = options.runId;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const sent = streamable && body && typeof body === 'object'
        ? { ...body, stream: true, ...(path === '/chat/completions' ? { stream_options: { include_usage: true } } : {}) }
        : body;
      startedAt = Date.now();
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: sent === undefined ? undefined : JSON.stringify(sent),
        signal: options.signal,
      });
      latencyMs = Date.now() - startedAt;

      if (response.status === 402 && method === 'POST' && options.allowReplay !== false && hybridFallbackEnabled()) {
        const refusal = parseOtariHeaders(response.headers);
        const refusalBody = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
        const code = refusal.raw['otari-error-code'] ?? (typeof refusalBody?.code === 'string' ? refusalBody.code : null);
        if (code === 'insufficient_funds') {
          replay = { requestId: refusal.requestId, status: response.status, code, latencyMs };
          response = replayResponse({ path, body, stage: options.simStage });
        }
      }
    }

    const otariHeaders = parseOtariHeaders(response.headers);
    if (replay) otariHeaders.requestId = replay.requestId;
    const text = await response.text();
    // A stream's latency runs to its last byte, not to its headers.
    if (!simulated && !replay) latencyMs = Date.now() - startedAt;
    let parsed: unknown = text;
    let isJson = false;
    if (response.ok && /text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
      try {
        parsed = path === '/chat/completions' ? collectChatStream(text) : collectResponsesStream(text);
        isJson = true;
      } catch (error) {
        if (!(error instanceof StreamFailure)) throw error;
        throw new OtariError(
          `Otari ${response.status}: stream failed: ${error.message}`,
          502,
          otariHeaders.raw['otari-error-code'] ?? error.code,
          error.body,
          otariHeaders,
          latencyMs,
          replay,
        );
      }
    } else {
      try {
        parsed = JSON.parse(text);
        isJson = true;
      } catch {
        // Left as text: gateways and proxies can return non-JSON error pages.
      }
    }

    if (!response.ok) {
      const bodyCode = isJson ? (parsed as { code?: unknown } | null)?.code : undefined;
      throw new OtariError(
        errorMessage(response.status, parsed),
        response.status,
        otariHeaders.raw['otari-error-code'] ?? (typeof bodyCode === 'string' ? bodyCode : null),
        parsed,
        otariHeaders,
        latencyMs,
        replay,
      );
    }
    if (!isJson) {
      throw new OtariError(
        `Otari ${response.status}: expected a JSON response body`,
        response.status,
        null,
        text,
        otariHeaders,
        latencyMs,
      );
    }

    return { data: parsed as T, status: response.status, headers: otariHeaders, simulated, latencyMs, replay };
  }
}

/** Shared client configured from the environment. */
export const otari = new OtariClient();
