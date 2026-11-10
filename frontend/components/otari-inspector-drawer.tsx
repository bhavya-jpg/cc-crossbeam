'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangleIcon,
  BoxIcon,
  ChevronRightIcon,
  GlobeIcon,
  KeyRoundIcon,
  Loader2Icon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  RouteIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LOCAL_MODE, LOCAL_POLL_MS } from '@/lib/local-mode'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeAuth } from '@/lib/supabase/use-realtime-auth'
import {
  isTelemetryMessage,
  listConversations,
  OTARI_ROLES,
  parseTelemetry,
  summarizeTelemetry,
  type DemoScenario,
  type OtariTelemetryEvent,
  type OtariRefusal,
  type RoleSummary,
  type SourceSummary,
  type TelemetrySummary,
} from '@/lib/otari-telemetry'
import { cn } from '@/lib/utils'

// --- Demo controls ---

const DEMO_TOGGLES: Array<{ scenario: DemoScenario; label: string }> = [
  { scenario: 'guardrail-block', label: 'Simulate Prompt Injection PDF' },
  { scenario: 'provider-failover', label: 'Force Primary Provider Failover' },
  { scenario: 'exhausted-key', label: 'Switch to Exhausted Contractor Key' },
]

interface DemoResult {
  outcome: 'blocked' | 'not-blocked' | 'failed-over' | 'held' | 'not-held' | 'error'
  simulated: boolean
  status: number | null
  code: string | null
  message: string
  replay: OtariRefusal | null
}

export interface ActiveDemo {
  /** Only telemetry newer than this message counts, so a reload starts clean. */
  sinceMessageId: number
  running: boolean
  result?: DemoResult
  error?: string
}

export type ActiveDemos = Partial<Record<DemoScenario, ActiveDemo>>

function visibleEvents(events: OtariTelemetryEvent[], demos: ActiveDemos): OtariTelemetryEvent[] {
  return events.filter((event) => {
    if (!event.demoScenario) return true
    const demo = demos[event.demoScenario]
    return demo !== undefined && event.messageId > demo.sinceMessageId
  })
}

const OUTCOME_TITLE: Record<DemoResult['outcome'], string> = {
  blocked: '403 Blocked — Prompt Injection Detected',
  'not-blocked': 'The gateway did not block this payload',
  'failed-over': 'Failover triggered',
  held: 'Budget hold: the gateway refused to spend',
  'not-held': 'No budget hold: this key still has budget',
  error: 'The demo call failed',
}

// --- Small shared pieces ---

function SourceBanner({ source }: { source: SourceSummary }) {
  const { replayedCalls, simulatedCalls, lastRefusal } = source
  if (!replayedCalls && !simulatedCalls) return null
  const requestId = lastRefusal?.requestId?.slice(0, 8)
  return (
    <div className="space-y-0.5 border border-border/50 bg-muted/30 p-3 text-xs text-muted-foreground font-body">
      {replayedCalls > 0 && lastRefusal && (
        <p>
          <span className="font-semibold text-foreground">Replay mode.</span>{' '}
          Otari returned {lastRefusal.status} {lastRefusal.code} (request {requestId}, {lastRefusal.latencyMs} ms) on {replayedCalls} {replayedCalls === 1 ? 'call' : 'calls'}, so recorded Placentia output is shown and no model ran. It goes live on its own once the account has funds.
        </p>
      )}
      {simulatedCalls > 0 && (
        <p>
          <span className="font-semibold text-foreground">Simulated.</span>{' '}
          {simulatedCalls} {simulatedCalls === 1 ? 'call' : 'calls'} never reached the gateway.
        </p>
      )}
    </div>
  )
}

function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground font-body">
        <Icon className="size-3.5" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground font-body">{children}</p>
}

const usd = (value: number) => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`

// --- Control plane panels ---

function attemptLabel(role: RoleSummary): string {
  if (role.replay) return `Client attempt ${role.clientAttempts} · not served by a model`
  const gateway = role.gatewayAttempts ?? '—'
  return role.clientAttempts > (role.gatewayAttempts ?? 0)
    ? `Client attempt ${role.clientAttempts} · Otari-Attempt-Count: ${gateway}`
    : `Otari-Attempt-Count: ${gateway}`
}

function RoutingTable({ roles }: { roles: TelemetrySummary['roles'] }) {
  return (
    <ul className="divide-y divide-border/50 border border-border/50">
      {OTARI_ROLES.map(({ id, label, job }) => {
        const role = roles[id]
        const refused = role && role.status >= 400
        return (
          <li key={id} className="space-y-1.5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground font-body">{label}</span>
              {!role && <span className="text-xs text-muted-foreground font-body">{job}</span>}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {role?.demo && <Badge variant="outline" className="rounded-none font-body text-[10px] text-muted-foreground">DEMO</Badge>}
                {role?.failover && (
                  <Badge className="rounded-none border-warning/35 bg-warning/10 font-body text-[10px] font-bold text-warning">
                    FAILOVER TRIGGERED
                  </Badge>
                )}
              </div>
            </div>
            {role ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="max-w-full rounded-none font-mono text-[11px]">
                    <span className="truncate">{role.model ?? 'unknown model'}</span>
                  </Badge>
                  {role.replay ? (
                    <Badge className="rounded-full bg-muted font-body text-[11px] text-foreground">
                      Replay · gateway {role.replay.status}
                    </Badge>
                  ) : (
                    <Badge className="rounded-full bg-muted font-body text-[11px] text-foreground">
                      {role.provider ?? 'no provider reported'}
                    </Badge>
                  )}
                  {refused && (
                    <Badge variant="destructive" className="rounded-none font-body text-[11px]">
                      {role.status}{role.errorCode ? ` ${role.errorCode}` : ''}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-body">
                  {attemptLabel(role)}
                  {role.failover && (role.gatewayFallback ? ' · Otari-Fallback: true' : ' · Client-side retry')}
                  {role.calls > 1 && ` · ${role.calls} calls`}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground font-body">Waiting for this role</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function expiryLabel(expiresAt: string): string {
  const at = new Date(expiresAt)
  const sameDay = at.toDateString() === new Date().toDateString()
  const when = sameDay ? at.toLocaleTimeString() : at.toLocaleString()
  return `${at.getTime() < Date.now() ? 'Expired' : 'Expires'} ${when}`
}

function WebhookStatus({ webhooks }: { webhooks: TelemetrySummary['webhooks'] }) {
  if (!webhooks) return <p className="text-sm text-muted-foreground font-body">Not recorded for these calls</p>
  return (
    <div
      className={cn(
        'space-y-1 border p-3',
        webhooks.public ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border/50 text-foreground',
      )}
    >
      <p className="text-sm font-semibold font-body">{webhooks.label}</p>
      <p className="text-xs text-muted-foreground font-body">{webhooks.detail}</p>
    </div>
  )
}

function GuardrailShield({ guardrail }: { guardrail: TelemetrySummary['guardrail'] }) {
  const Icon = guardrail.tone === 'blocked' ? ShieldAlertIcon : guardrail.tone === 'passed' ? ShieldCheckIcon : ShieldIcon
  return (
    <div
      className={cn(
        'flex items-center gap-3 border p-3',
        guardrail.tone === 'blocked' && 'border-destructive/40 bg-destructive/10 text-destructive',
        guardrail.tone === 'passed' && 'border-primary/30 bg-primary/5 text-primary',
        guardrail.tone === 'warning' && 'border-border bg-secondary text-foreground',
        guardrail.tone === 'none' && 'border-border/50 text-muted-foreground',
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden />
      <span className="text-sm font-semibold font-body">{guardrail.label}</span>
    </div>
  )
}

function ContainerPill({ container }: { container: TelemetrySummary['container'] }) {
  if (!container) return <Empty>No code container has run yet. The analyst role opens one on a live model call.</Empty>
  return (
    <div className="space-y-1.5 border border-border/50 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="max-w-full rounded-none font-mono text-[11px]">
          <span className="truncate">{container.id}</span>
        </Badge>
        <Badge className={cn('rounded-none font-body text-[11px]', !container.reused && 'bg-muted text-foreground')}>
          {container.reused ? `Reused across ${container.turns} turns` : 'Used on 1 turn'}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground font-body">
        {container.expiresAt ? expiryLabel(container.expiresAt) : 'The gateway reported no expiry'}
      </p>
    </div>
  )
}

function BudgetBar({ budget }: { budget: TelemetrySummary['budget'] }) {
  if (!budget) return <Empty>No spend yet.</Empty>
  const holdDetail = [budget.holdStatus, budget.holdCode, budget.holdScope && `scope: ${budget.holdScope}`].filter(Boolean).join(' · ')
  return (
    <div className="space-y-2 border border-border/50 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="max-w-full rounded-none font-mono text-[11px]">
          <span className="truncate">{budget.keyLabel}</span>
        </Badge>
        <Badge
          variant={budget.state === 'hold' ? 'destructive' : 'default'}
          className={cn(
            'ml-auto rounded-none font-body text-[11px]',
            budget.state === 'ok' && 'bg-primary/10 text-primary',
            (budget.state === 'over-cap' || budget.state === 'no-funds') && 'border-warning/35 bg-warning/10 text-warning',
          )}
        >
          {budget.state === 'hold' ? 'HOLD' : budget.state === 'over-cap' ? 'Over display cap' : budget.state === 'no-funds' ? 'No funds' : 'No hold'}
        </Badge>
      </div>
      <div
        role="progressbar"
        aria-label="Spend against the budget cap"
        aria-valuemin={0}
        aria-valuemax={budget.capUsd}
        aria-valuenow={Math.min(budget.spentUsd, budget.capUsd)}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full transition-all', budget.state === 'hold' ? 'bg-destructive' : budget.state === 'over-cap' ? 'bg-warning' : 'bg-primary')}
          style={{ width: `${budget.percent}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground font-body">
        <span className="font-semibold text-foreground">{usd(budget.spentUsd)}</span> agent_cost_usd of {usd(budget.capUsd)} cap on this project
      </p>
      {budget.state === 'hold' && (
        <p className="text-xs text-destructive font-body">
          {holdDetail}{budget.holdMessage ? `: ${budget.holdMessage}` : ''}
        </p>
      )}
      {budget.keySource === 'workspace' && (
        <p className="text-xs text-muted-foreground font-body">No contractor key is configured, so this run uses the workspace key.</p>
      )}
    </div>
  )
}

// --- Trace Explorer ---

interface TraceResponse {
  source: 'gateway' | 'collected'
  reason: string | null
  trace: unknown
  spans: Array<Partial<OtariTelemetryEvent>>
  error?: string
}

function TraceExplorer({ conversations }: { conversations: string[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)
  const [state, setState] = useState<{ loading: boolean; data?: TraceResponse; error?: string }>({ loading: false })
  const conversationId = selected && conversations.includes(selected) ? selected : conversations[0]

  useEffect(() => {
    if (!conversationId) return
    const controller = new AbortController()
    setState({ loading: true })
    fetch(`/api/otari/traces/${encodeURIComponent(conversationId)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as TraceResponse
        setState(response.ok ? { loading: false, data } : { loading: false, error: data.error ?? `Request failed: ${response.status}` })
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ loading: false, error: error.message })
      })
    return () => controller.abort()
  }, [conversationId, refreshCount])

  if (!conversationId) return <Empty>Traces appear after the first Otari call.</Empty>

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label htmlFor="otari-conversation" className="sr-only">Conversation</label>
        <select
          id="otari-conversation"
          value={conversationId}
          onChange={(event) => setSelected(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-2 py-1.5 font-mono text-xs text-foreground"
        >
          {conversations.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <Button variant="outline" size="icon-sm" aria-label="Refresh trace" onClick={() => setRefreshCount((count) => count + 1)}>
          <RefreshCwIcon className={cn('size-3.5', state.loading && 'animate-spin')} aria-hidden />
        </Button>
      </div>

      {state.error && <p className="text-sm text-destructive font-body">{state.error}</p>}
      {state.data && (
        <>
          <div className="space-y-1">
            <Badge className={cn('rounded-none font-body text-[11px]', state.data.source === 'collected' && 'bg-muted text-foreground')}>
              {state.data.source === 'gateway' ? 'Gateway trace' : 'Server-collected telemetry'}
            </Badge>
            {state.data.reason && <p className="text-xs text-muted-foreground font-body">{state.data.reason}</p>}
          </div>

          {state.data.source === 'gateway' ? (
            <pre className="max-h-96 overflow-auto border border-border/50 bg-muted/30 p-3 font-mono text-[11px] text-foreground">
              {JSON.stringify(state.data.trace, null, 2)}
            </pre>
          ) : state.data.spans.length === 0 ? (
            <Empty>No spans were collected for this conversation.</Empty>
          ) : (
            <ol className="divide-y divide-border/50 border border-border/50">
              {state.data.spans.map((span, index) => (
                <li key={span.requestId ?? index} className="space-y-1 p-3">
                  <div className="flex items-center gap-2 text-sm font-body">
                    <span className="font-semibold capitalize text-foreground">{span.role}</span>
                    <span className="font-mono text-xs text-muted-foreground">{span.status}</span>
                    {span.replay && <span className="text-xs text-muted-foreground">replay of {span.replay.status}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {span.latencyMs ? `${span.latencyMs} ms · ` : ''}{usd(span.costUsd ?? 0)}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{span.model ?? 'unknown model'}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{span.requestId ?? 'no request ID'}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  )
}

// --- View ---

export interface OtariInspectorViewProps {
  events: OtariTelemetryEvent[]
  demos: ActiveDemos
  onToggleDemo: (scenario: DemoScenario) => void
  onClose: () => void
}

export function OtariInspectorView({ events, demos, onToggleDemo, onClose }: OtariInspectorViewProps) {
  const [tab, setTab] = useState<'control-plane' | 'traces'>('control-plane')
  const shown = useMemo(() => visibleEvents(events, demos), [events, demos])
  const summary = useMemo(() => summarizeTelemetry(shown), [shown])
  const conversations = useMemo(() => listConversations(shown), [shown])
  const anyRunning = Object.values(demos).some((demo) => demo?.running)

  return (
    <aside
      aria-label="Otari.ai Control Plane"
      className="fixed inset-y-0 right-0 z-[60] flex w-full flex-col border-l border-border/50 bg-card shadow-[0_1px_2px_rgba(10,10,10,0.04)] sm:w-[440px]"
    >
      <header className="space-y-3 border-b border-border/50 p-4">
        <div className="flex items-center gap-2">
          <h2 className="heading-card text-foreground">Otari.ai Control Plane</h2>
          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close inspector" onClick={onClose}>
            <ChevronRightIcon className="size-4" aria-hidden />
          </Button>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground font-body">Live Judge Demo</p>
          {DEMO_TOGGLES.map(({ scenario, label }) => {
            const demo = demos[scenario]
            const on = demo !== undefined
            return (
              <button
                key={scenario}
                type="button"
                role="switch"
                aria-checked={on}
                disabled={anyRunning}
                onClick={() => onToggleDemo(scenario)}
                className={cn(
                  'flex min-h-9 w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm font-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                  on ? 'border-primary/40 bg-primary/5 text-foreground' : 'border-border/50 text-foreground hover:bg-muted/40',
                )}
              >
                <span className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors', on ? 'bg-primary' : 'bg-muted-foreground/30')} aria-hidden>
                  <span className={cn('absolute top-0.5 size-3 rounded-full bg-white transition-all', on ? 'left-3.5' : 'left-0.5')} />
                </span>
                <span className="min-w-0 flex-1">{label}</span>
                {demo?.running && <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />}
              </button>
            )
          })}
        </div>
      </header>

      <div role="tablist" aria-label="Inspector views" className="flex border-b border-border/50 px-4">
        {([['control-plane', 'Control Plane'], ['traces', 'Trace Explorer']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-semibold font-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4" aria-live="polite">
        <SourceBanner source={summary.source} />
        {DEMO_TOGGLES.map(({ scenario }) => {
          const demo = demos[scenario]
          if (!demo || demo.running) return null
          const result = demo.result
          const severe = result ? ['blocked', 'held', 'error'].includes(result.outcome) : true
          return (
            <div
              key={scenario}
              role="alert"
              className={cn(
                'flex gap-3 border p-3',
                severe ? 'border-destructive/40 bg-destructive/10' : 'border-warning/35 bg-warning/[0.06]',
              )}
            >
              <AlertTriangleIcon className={cn('mt-0.5 size-4 shrink-0', severe ? 'text-destructive' : 'text-warning')} aria-hidden />
              <div className="min-w-0 space-y-1">
                <p className={cn('text-sm font-semibold font-body', severe ? 'text-destructive' : 'text-warning')}>
                  {result ? OUTCOME_TITLE[result.outcome] : 'The demo call failed'}
                </p>
                <p className="break-words text-xs text-foreground font-body">{result?.message ?? demo.error}</p>
                {result && (
                  <div className="flex flex-wrap gap-1.5">
                    {result.status !== null && !result.replay && (
                      <Badge variant="outline" className="rounded-none font-mono text-[10px]">
                        {result.status}{result.code ? ` ${result.code}` : ''}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {tab === 'control-plane' ? (
          <>
            <Section icon={RouteIcon} title="Multi-model routing"><RoutingTable roles={summary.roles} /></Section>
            <Section icon={ShieldIcon} title="Inference guardrails"><GuardrailShield guardrail={summary.guardrail} /></Section>
            <Section icon={GlobeIcon} title="Gateway webhooks"><WebhookStatus webhooks={summary.webhooks} /></Section>
            <Section icon={BoxIcon} title="Sandbox container"><ContainerPill container={summary.container} /></Section>
            <Section icon={KeyRoundIcon} title="Contractor key and budget"><BudgetBar budget={summary.budget} /></Section>
          </>
        ) : (
          <TraceExplorer conversations={conversations} />
        )}
      </div>
    </aside>
  )
}

// --- Drawer: data and open state ---

interface OtariInspectorDrawerProps {
  projectId: string
  defaultOpen?: boolean
}

export function OtariInspectorDrawer({ projectId, defaultOpen = false }: OtariInspectorDrawerProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [messages, setMessages] = useState<Array<{ id: number; content: string }>>([])
  const [demos, setDemos] = useState<ActiveDemos>({})
  const supabase = useMemo(() => createClient(), [])
  const realtimeReady = useRealtimeAuth(supabase)

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .schema('crossbeam')
      .from('messages')
      .select('id, content')
      .eq('project_id', projectId)
      .like('content', '[OTARI_TELEMETRY]%')
      .order('id', { ascending: true })
    if (data) setMessages(data as Array<{ id: number; content: string }>)
  }, [projectId, supabase])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Local mode has no Realtime, so it polls.
  useEffect(() => {
    if (!LOCAL_MODE) return
    const interval = setInterval(refresh, LOCAL_POLL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  useEffect(() => {
    if (!realtimeReady || LOCAL_MODE) return
    const channel = supabase
      .channel(`otari-telemetry-${projectId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'crossbeam', table: 'messages', filter: `project_id=eq.${projectId}` },
        (payload) => {
          const message = payload.new as { id: number; content: string }
          if (!isTelemetryMessage(message.content)) return
          setMessages((previous) => (previous.some(({ id }) => id === message.id) ? previous : [...previous, message]))
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [projectId, supabase, realtimeReady])

  const events = useMemo(() => parseTelemetry(messages), [messages])

  // On wide screens the page makes room, so the drawer never covers the live activity feed.
  useEffect(() => {
    document.body.classList.toggle('otari-drawer-open', open)
    return () => document.body.classList.remove('otari-drawer-open')
  }, [open])

  const toggleDemo = useCallback(async (scenario: DemoScenario) => {
    if (demos[scenario]) {
      setDemos(({ [scenario]: _removed, ...rest }) => rest)
      return
    }
    const sinceMessageId = messages[messages.length - 1]?.id ?? 0
    setDemos((previous) => ({ ...previous, [scenario]: { sinceMessageId, running: true } }))

    let outcome: Pick<ActiveDemo, 'result' | 'error'>
    try {
      const response = await fetch('/api/otari/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, scenario }),
      })
      const data = await response.json()
      outcome = response.ok ? { result: data as DemoResult } : { error: data.error ?? `Request failed: ${response.status}` }
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : 'Request failed' }
    }
    setDemos((previous) => ({ ...previous, [scenario]: { sinceMessageId, running: false, ...outcome } }))
    // Realtime can lag the response, and the panels should match the alert straight away.
    await refresh()
  }, [demos, messages, projectId, refresh])

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-0 top-1/2 z-40 flex -translate-y-1/2 items-center gap-2 rounded-l-xl border border-r-0 border-border/50 bg-card px-3 py-3 text-sm font-semibold text-foreground shadow-[0_1px_2px_rgba(10,10,10,0.04)] transition-colors font-body hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PanelRightOpenIcon className="size-4" aria-hidden />
        Otari
        {events.length > 0 && <span className="text-xs font-normal text-muted-foreground">{events.length}</span>}
      </button>
    )
  }

  return <OtariInspectorView events={events} demos={demos} onToggleDemo={toggleDemo} onClose={() => setOpen(false)} />
}
