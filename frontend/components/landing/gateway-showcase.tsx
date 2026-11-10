'use client'

import { useEffect, useRef, useState } from 'react'
import { PlayIcon, RotateCcwIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ALL_CALLS, clock, RUN, STAGES, type StageId } from '@/lib/recorded-run'

const SPEED = 60
const TICKS = [0, 120, 240, 360, 480, 600, 720]

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`
const pct = (seconds: number) => `${(seconds / RUN.durationS) * 100}%`

/**
 * The recorded run as a schedule: one lane per agent, one bar per gateway call, from when
 * it was sent to when it answered. Replay moves a playhead across at 60x.
 */
export function GatewayShowcase() {
  const [selected, setSelected] = useState<StageId>('extractor')
  // Starts complete, so the figures read right before anyone presses play.
  const [t, setT] = useState(RUN.durationS)
  const [playing, setPlaying] = useState(false)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const tick = (now: number) => {
      // Read the step before moving `last`: the state updater runs later.
      const step = ((now - last) / 1000) * SPEED
      last = now
      setT((prev) => Math.min(RUN.durationS, prev + step))
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
    }
  }, [playing])

  useEffect(() => {
    if (playing && t >= RUN.durationS) setPlaying(false)
  }, [playing, t])

  const done = ALL_CALLS.filter((call) => call.at <= t)
  const spent = done.reduce((sum, call) => sum + call.costUsd, 0)
  const stage = STAGES.find((s) => s.id === selected) ?? STAGES[0]

  const replay = () => {
    setT(0)
    setPlaying(true)
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {/* Readouts */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {[
            ['Elapsed', clock(t)],
            ['Calls', `${done.length} / ${ALL_CALLS.length}`],
            ['Spend', usd(spent)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="readout text-sm text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          onClick={replay}
          disabled={playing}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3.5 text-sm font-medium text-foreground transition-colors hover:border-foreground/30 disabled:opacity-50"
        >
          {t >= RUN.durationS ? <RotateCcwIcon className="size-3.5" aria-hidden /> : <PlayIcon className="size-3.5" aria-hidden />}
          Replay at {SPEED}×
        </button>
      </div>

      {/* Schedule */}
      <div className="px-5 pb-5 pt-9">
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-[96px] right-0 sm:left-[128px]" aria-hidden>
            {TICKS.map((s) => (
              <span key={s} className="absolute inset-y-0 w-px bg-border" style={{ left: pct(s) }}>
                <span className="readout absolute -top-6 -translate-x-1/2 text-[10px] text-muted-foreground">{s / 60}m</span>
              </span>
            ))}
            <span className="absolute -inset-y-1.5 w-px bg-foreground" style={{ left: pct(t) }} />
          </div>

          <ol className="relative space-y-1" aria-label="Calls by agent">
            {STAGES.map((s) => {
              const active = selected === s.id
              return (
                <li key={s.id} className="flex items-center">
                  <button
                    type="button"
                    onClick={() => setSelected(s.id)}
                    aria-pressed={active}
                    className={cn(
                      'w-[96px] shrink-0 py-2 pr-3 text-left text-sm transition-colors sm:w-[128px]',
                      active ? 'font-medium text-primary' : 'text-foreground hover:text-primary',
                    )}
                  >
                    {s.title}
                  </button>
                  <div className={cn('relative h-8 flex-1 rounded-sm', active ? 'bg-primary/[0.05]' : 'bg-secondary/70')}>
                    {s.calls.map((call, i) => {
                      const start = Math.max(0, call.at - call.latencyMs / 1000)
                      const width = Math.max(call.latencyMs / 1000, 3)
                      const shown = call.at <= t
                      const running = !shown && start <= t
                      return (
                        <span
                          key={i}
                          title={`${s.title} call ${i + 1}: ${call.status} · ${(call.latencyMs / 1000).toFixed(1)} s · ${usd(call.costUsd)}`}
                          className={cn(
                            'absolute top-1/2 h-3 -translate-y-1/2 rounded-[2px] transition-opacity duration-300',
                            call.status >= 400 ? 'bg-warning' : 'bg-primary',
                            shown ? 'opacity-100' : running ? 'opacity-50' : 'opacity-[0.12]',
                          )}
                          style={{ left: pct(start), width: pct(width) }}
                        />
                      )
                    })}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
        <div className="mt-4 flex flex-wrap gap-5 pl-[96px] text-xs text-muted-foreground sm:pl-[128px]">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-[1px] bg-primary" aria-hidden /> Served</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-[1px] bg-warning" aria-hidden /> Refused, then retried</span>
        </div>
      </div>

      {/* Selected agent */}
      <div className="grid border-t border-border lg:grid-cols-2">
        <div className="p-6">
          <p className="text-xs text-muted-foreground">Agent {stage.index} · via {stage.provider}</p>
          <h3 className="mt-2 font-display text-3xl tracking-[-0.02em] text-foreground">{stage.title}</h3>
          <p className="readout mt-3 inline-block rounded bg-primary/[0.07] px-2 py-1 text-xs text-primary">{stage.model}</p>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-foreground/80">{stage.job}</p>
          <ul className="mt-5 space-y-1.5 border-t border-border pt-4">
            {stage.gateway.map((line) => (
              <li key={line} className="flex gap-2.5 text-sm text-muted-foreground">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-primary" aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-border lg:border-l lg:border-t-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[300px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  {['Call', 'Status', 'Latency', 'Cost'].map((h, i) => (
                    <th key={h} className={cn('border-b border-border px-6 py-3 font-normal', i > 1 && 'text-right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="readout text-[13px]">
                {stage.calls.map((call, i) => {
                  const shown = call.at <= t
                  return (
                    <tr key={i} className={cn('border-b border-border/70 transition-opacity last:border-0', !shown && 'opacity-30')}>
                      <td className="px-6 py-2.5 text-muted-foreground">{i + 1}</td>
                      <td className={cn('px-6 py-2.5', call.status >= 400 ? 'text-warning' : 'text-foreground')}>{shown ? call.status : '—'}</td>
                      <td className="px-6 py-2.5 text-right text-foreground">{shown ? `${(call.latencyMs / 1000).toFixed(1)} s` : '—'}</td>
                      <td className="px-6 py-2.5 text-right text-foreground">{shown ? usd(call.costUsd) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{RUN.label}</p>
    </div>
  )
}
