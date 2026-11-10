'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { JUDGE_CONTRACTOR_PROJECT_ID } from '@/lib/app-mode'
import { getStatusConfig } from '@/lib/status-utils'
import { OpenWorkspaceButton } from '@/components/open-workspace-button'
import type { Project, ProjectStatus } from '@/types/database'

interface Snapshot {
  status: ProjectStatus
  name: string
  address: string
  items: number | null
  costUsd: number | null
  durationMs: number | null
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** The seeded Placentia contractor project, as it stands now, with a one-click way in. */
export function LiveReviewCard() {
  const supabase = useMemo(() => createClient(), [])
  const [snap, setSnap] = useState<Snapshot | null>(null)

  useEffect(() => {
    const projectId = JUDGE_CONTRACTOR_PROJECT_ID
    Promise.all([
      supabase.schema('crossbeam').from('projects').select('*').eq('id', projectId).single(),
      supabase.schema('crossbeam').from('outputs').select('raw_artifacts, agent_cost_usd, agent_duration_ms')
        .eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).single(),
    ]).then(([project, output]) => {
      const p = project.data as Project | null
      if (!p) return
      const out = output.data as { raw_artifacts?: Record<string, { items?: unknown[] }>; agent_cost_usd?: number | null; agent_duration_ms?: number | null } | null
      const items = out?.raw_artifacts?.['corrections_parsed.json']?.items
      setSnap({
        status: p.status,
        name: p.project_name,
        address: [p.project_address, p.city].filter(Boolean).join(', '),
        items: Array.isArray(items) ? items.length : null,
        costUsd: out?.agent_cost_usd ?? null,
        durationMs: out?.agent_duration_ms ?? null,
      })
    })
  }, [supabase])

  if (!snap) return null
  const status = getStatusConfig(snap.status)

  return (
    <section className="glass relative mx-auto max-w-4xl overflow-hidden">
      <div className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <p className="eyebrow">Live permit review</p>
          <h2 className="font-display text-3xl leading-tight tracking-[-0.02em] text-foreground">{snap.name}</h2>
          <p className="text-sm text-muted-foreground">{snap.address}</p>
          <span className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-medium ${status.className ?? 'border-border text-foreground'}`}>
            {status.label}
          </span>
        </div>
        <OpenWorkspaceButton />
      </div>
      <dl className="grid grid-cols-3 gap-px border-t border-border bg-border">
        {[
          ['Correction items', snap.items !== null ? String(snap.items) : '—'],
          ['Spent via Otari', snap.costUsd !== null ? `$${snap.costUsd.toFixed(2)}` : '—'],
          ['Last run', snap.durationMs ? duration(snap.durationMs) : '—'],
        ].map(([label, value]) => (
          <div key={label} className="bg-background/85 px-6 py-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="readout mt-0.5 text-lg text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
