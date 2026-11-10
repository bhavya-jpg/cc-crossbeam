'use client'

import { useEffect, useState } from 'react'
import { ChevronRightIcon, FileTextIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase/client'

interface CorrectionItem {
  item_number?: string | number
  section?: string
  description?: string
  severity_hint?: string
  referenced_sheets?: string[]
}

/** The items the extractor read from the city's corrections letter, from the latest Phase 1 output. */
export function CorrectionItemsSummary({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<CorrectionItem[] | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .schema('crossbeam')
      .from('outputs')
      .select('raw_artifacts')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
      .then(({ data }) => {
        const parsed = (data?.raw_artifacts as Record<string, unknown> | undefined)?.['corrections_parsed.json'] as
          | { items?: CorrectionItem[] }
          | undefined
        setItems(Array.isArray(parsed?.items) ? parsed.items : [])
      })
  }, [projectId])

  if (!items || items.length === 0) return null

  return (
    <details className="group max-w-2xl mx-auto border border-border/50 bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4">
        <FileTextIcon className="size-5 shrink-0 text-primary" aria-hidden />
        <span className="flex-1 text-sm font-semibold font-body text-foreground">
          {items.length} correction items read from the city&apos;s letter
        </span>
        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <ol className="space-y-3 border-t border-border/50 px-5 py-4">
        {items.map((item, index) => (
          <li key={`${item.item_number ?? index}`} className="flex gap-3 text-sm font-body">
            <span className="w-6 shrink-0 text-right font-semibold text-primary">{item.item_number ?? index + 1}.</span>
            <div className="min-w-0 space-y-1">
              <p className="text-foreground">{item.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {item.section && <Badge variant="outline" className="rounded-full text-[10px]">{item.section}</Badge>}
                {item.severity_hint && <Badge variant="secondary" className="rounded-full text-[10px]">{item.severity_hint}</Badge>}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}
