/**
 * Reads the `[OTARI_TELEMETRY]` messages the server's runner writes to the project's
 * message stream, and reduces them to what the Inspector shows. Pure, so the server's
 * tests can check it against real runner output.
 */

export const TELEMETRY_PREFIX = '[OTARI_TELEMETRY] '

export const OTARI_ROLES = [
  { id: 'extractor', label: 'Extractor', job: 'Reads letters and plans' },
  { id: 'researcher', label: 'Researcher', job: 'City code lookup' },
  { id: 'analyst', label: 'Analyst', job: 'Setback and coverage checks' },
  { id: 'drafter', label: 'Drafter', job: 'Law and deliverables' },
] as const

export type OtariRoleId = (typeof OTARI_ROLES)[number]['id']
export type DemoScenario = 'guardrail-block' | 'provider-failover' | 'exhausted-key'

export interface OtariTelemetryEvent {
  messageId: number
  role: OtariRoleId
  model: string | null
  provider: string | null
  requestId: string | null
  fallback: boolean
  gatewayFallback: boolean
  attemptCount: number | null
  attempt: number
  guardrailsVerdict: string | null
  guardrailMode: 'monitor' | 'block' | null
  blocked: boolean
  budgetHold: boolean
  budgetScope: string | null
  errorCode: string | null
  error: string | null
  containerId: string | null
  containerExpiresAt: string | null
  costUsd: number
  costSource: 'reported' | 'estimated'
  status: number
  simulated: boolean
  conversationId: string
  keyLabel: string
  keySource: 'contractor' | 'workspace' | 'simulated'
  budgetCapUsd: number
  demoScenario: DemoScenario | null
  latencyMs: number
  /** The gateway's real refusal, when recorded output stands in for this call. */
  replay: OtariRefusal | null
  /** Whether the gateway could reach our MCP server and guardrail service. Absent on older events. */
  publicWebhooks?: { mcp: boolean; guardrail: boolean }
}

export interface OtariRefusal {
  requestId: string | null
  status: number
  code: string | null
  latencyMs: number
}

export function isTelemetryMessage(content: string): boolean {
  return content.startsWith(TELEMETRY_PREFIX)
}

export function parseTelemetry(messages: Array<{ id: number; content: string }>): OtariTelemetryEvent[] {
  return messages.flatMap(({ id, content }) => {
    if (!isTelemetryMessage(content)) return []
    try {
      const event = JSON.parse(content.slice(TELEMETRY_PREFIX.length)) as Omit<OtariTelemetryEvent, 'messageId'>
      return OTARI_ROLES.some((role) => role.id === event.role) ? [{ ...event, messageId: id }] : []
    } catch {
      return []
    }
  })
}

export interface RoleSummary {
  model: string | null
  provider: string | null
  /** Highest `Otari-Attempt-Count` the gateway reported. */
  gatewayAttempts: number | null
  /** Models or tool sets this client tried for the role's latest call. */
  clientAttempts: number
  failover: boolean
  gatewayFallback: boolean
  status: number
  errorCode: string | null
  calls: number
  demo: boolean
  replay: OtariRefusal | null
}

export type GuardrailTone = 'none' | 'passed' | 'warning' | 'blocked'

export interface GuardrailSummary {
  label: string
  tone: GuardrailTone
}

export interface ContainerSummary {
  id: string
  expiresAt: string | null
  turns: number
  reused: boolean
}

export interface BudgetSummary {
  keyLabel: string
  keySource: OtariTelemetryEvent['keySource']
  spentUsd: number
  capUsd: number
  percent: number
  /** `no-funds` is a real refusal that recorded output covered, so the run carried on. */
  state: 'ok' | 'over-cap' | 'hold' | 'no-funds'
  holdStatus: number | null
  holdCode: string | null
  holdScope: string | null
  holdMessage: string | null
}

/** Where the numbers on screen came from. The Inspector always says, in one banner. */
export interface SourceSummary {
  liveCalls: number
  replayedCalls: number
  simulatedCalls: number
  lastRefusal: OtariRefusal | null
}

export interface WebhookSummary {
  label: string
  detail: string
  /** True when both webhooks were public for the latest call. */
  public: boolean
}

export const LOCAL_WEBHOOKS_LABEL = 'MCP & Guardrail Webhooks: Localhost Fallback Active (Direct Skill Injection)'

export interface TelemetrySummary {
  roles: Partial<Record<OtariRoleId, RoleSummary>>
  guardrail: GuardrailSummary
  webhooks: WebhookSummary | null
  container: ContainerSummary | null
  budget: BudgetSummary | null
  source: SourceSummary
}

function summarizeRole(events: OtariTelemetryEvent[]): RoleSummary | undefined {
  const last = events[events.length - 1]
  if (!last) return undefined
  const sameRun = events.filter((event) => event.conversationId === last.conversationId)
  const gatewayCounts = sameRun.flatMap((event) => (event.attemptCount === null ? [] : [event.attemptCount]))
  return {
    model: last.model,
    provider: last.provider,
    gatewayAttempts: gatewayCounts.length ? Math.max(...gatewayCounts) : null,
    clientAttempts: Math.max(...sameRun.map((event) => event.attempt)),
    failover: sameRun.some((event) => event.fallback),
    gatewayFallback: sameRun.some((event) => event.gatewayFallback),
    status: last.status,
    errorCode: last.errorCode,
    calls: sameRun.length,
    demo: Boolean(last.demoScenario),
    replay: last.replay,
  }
}

function summarizeGuardrail(events: OtariTelemetryEvent[]): GuardrailSummary {
  // A call refused for funds never reached the guardrail, so it says nothing about it.
  const relevant = events.filter((event) =>
    event.blocked || event.guardrailsVerdict || (event.guardrailMode && (event.replay || event.status === 200)))
  const last = relevant[relevant.length - 1]
  if (!last) return { label: 'No guardrail result yet', tone: 'none' }
  if (last.blocked) {
    return { label: `${last.status} Blocked — Prompt Injection Detected${last.replay ? ' (replay)' : ''}`, tone: 'blocked' }
  }
  // The gateway refused before any guardrail ran, so a replayed call has no verdict to show.
  if (last.replay) {
    return { label: `${last.guardrailMode}: not evaluated, gateway returned ${last.replay.status}`, tone: 'warning' }
  }
  // Streamed responses don't carry Otari-Guardrails, so a served call can have no verdict.
  if (!last.guardrailsVerdict) {
    return { label: `${last.guardrailMode}: requested, no verdict on a streamed response`, tone: 'warning' }
  }
  const verdict = last.guardrailsVerdict
  return {
    label: `${last.guardrailMode ?? 'monitor'}: ${verdict}`,
    tone: verdict === 'passed' ? 'passed' : verdict === 'flagged' ? 'blocked' : 'warning',
  }
}

function summarizeContainer(events: OtariTelemetryEvent[]): ContainerSummary | null {
  const withContainer = events.filter((event) => event.containerId)
  const last = withContainer[withContainer.length - 1]
  if (!last?.containerId) return null
  const turns = withContainer.filter((event) => event.containerId === last.containerId).length
  return { id: last.containerId, expiresAt: last.containerExpiresAt, turns, reused: turns > 1 }
}

function summarizeBudget(events: OtariTelemetryEvent[]): BudgetSummary | null {
  const last = events[events.length - 1]
  if (!last) return null
  const spentUsd = events
    .filter((event) => event.keyLabel === last.keyLabel)
    .reduce((sum, event) => sum + event.costUsd, 0)
  const state = last.budgetHold ? 'hold' : last.replay ? 'no-funds' : spentUsd > last.budgetCapUsd ? 'over-cap' : 'ok'
  return {
    keyLabel: last.keyLabel,
    keySource: last.keySource,
    spentUsd,
    capUsd: last.budgetCapUsd,
    percent: state === 'hold' || state === 'over-cap' ? 100 : Math.min(100, (spentUsd / last.budgetCapUsd) * 100),
    state,
    holdStatus: last.budgetHold ? last.status : null,
    holdCode: last.budgetHold ? last.errorCode : null,
    holdScope: last.budgetHold ? last.budgetScope : null,
    holdMessage: last.budgetHold ? last.error : null,
  }
}

function summarizeWebhooks(events: OtariTelemetryEvent[]): WebhookSummary | null {
  const last = [...events].reverse().find((event) => event.publicWebhooks)?.publicWebhooks
  if (!last) return null
  if (!last.mcp && !last.guardrail) {
    return {
      label: LOCAL_WEBHOOKS_LABEL,
      detail: 'No public URL, so the drafter reads the law references through a local tool loop, and the gateway cannot run the guardrail check.',
      public: false,
    }
  }
  const part = (name: string, on: boolean, off: string) => `${name}: ${on ? 'called by the gateway' : off}`
  return {
    label: last.mcp && last.guardrail ? 'MCP & Guardrail Webhooks: public, called by the gateway' : 'MCP & Guardrail Webhooks: partly public',
    detail: [part('MCP', last.mcp, 'local tool loop'), part('Guardrail', last.guardrail, 'not reachable, so not evaluated')].join(' · '),
    public: last.mcp && last.guardrail,
  }
}

function summarizeSource(events: OtariTelemetryEvent[]): SourceSummary {
  const replayed = events.filter((event) => event.replay)
  const simulatedCalls = events.filter((event) => event.simulated).length
  return {
    liveCalls: events.length - replayed.length - simulatedCalls,
    replayedCalls: replayed.length,
    simulatedCalls,
    lastRefusal: replayed[replayed.length - 1]?.replay ?? null,
  }
}

/** Covers the project's messages, which a reset clears. A contractor flow spans two runs. */
export function summarizeTelemetry(events: OtariTelemetryEvent[]): TelemetrySummary {
  const roles: TelemetrySummary['roles'] = {}
  for (const { id } of OTARI_ROLES) {
    const summary = summarizeRole(events.filter((event) => event.role === id))
    if (summary) roles[id] = summary
  }
  return {
    roles,
    guardrail: summarizeGuardrail(events),
    webhooks: summarizeWebhooks(events),
    container: summarizeContainer(events),
    budget: summarizeBudget(events),
    source: summarizeSource(events),
  }
}

/** Conversation IDs, most recent first. */
export function listConversations(events: OtariTelemetryEvent[]): string[] {
  return [...new Set(events.map((event) => event.conversationId).reverse())]
}
