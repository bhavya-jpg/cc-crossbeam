'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRightIcon, Loader2Icon } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { JUDGE_CONTRACTOR_PROJECT_ID } from '@/lib/app-mode'
import { LOCAL_DEMO_USER, LOCAL_MODE } from '@/lib/local-mode'
import { PUBLIC_SITE, RUN_LOCALLY_URL } from '@/lib/brand'
import { cn } from '@/lib/utils'

interface Props {
  className?: string
  label?: string
  variant?: 'primary' | 'secondary'
}

/**
 * Opens the Placentia permit review in one click. In local mode it signs into the local
 * stand-in's demo account first; otherwise the dashboard's own sign-in applies.
 */
export function OpenWorkspaceButton({ className, label = 'Open Live Permit Review Workspace', variant = 'primary' }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      if (LOCAL_MODE) {
        const supabase = createClient()
        const { data } = await supabase.auth.getUser()
        if (!data.user) {
          const { error: signInError } = await supabase.auth.signInWithPassword(LOCAL_DEMO_USER)
          if (signInError) throw signInError
        }
        router.push(`/projects/${JUDGE_CONTRACTOR_PROJECT_ID}`)
      } else {
        router.push('/dashboard')
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the workspace')
      setBusy(false)
    }
  }

  const look = cn(
    'group inline-flex h-11 items-center gap-2 rounded-md px-5 text-sm font-medium transition-colors disabled:opacity-70',
    variant === 'primary'
      ? 'bg-primary text-primary-foreground hover:bg-[#1630D6]'
      : 'border border-border bg-background text-foreground hover:border-foreground/30',
    className,
  )

  // The hosted site has no agent server; the workspace runs locally with your own Otari key.
  if (PUBLIC_SITE) {
    return (
      <span className="inline-flex flex-col items-start gap-1.5">
        <a href={RUN_LOCALLY_URL} target="_blank" rel="noopener noreferrer" className={look}>
          Run the workspace locally
          <ArrowRightIcon className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" aria-hidden />
        </a>
        <span className="text-xs opacity-60">One script, your own Otari key</span>
      </span>
    )
  }

  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className={cn(
          'group inline-flex h-11 items-center gap-2 rounded-md px-5 text-sm font-medium transition-colors disabled:opacity-70',
          variant === 'primary'
            ? 'bg-primary text-primary-foreground hover:bg-[#1630D6]'
            : 'border border-border bg-background text-foreground hover:border-foreground/30',
          className,
        )}
      >
        {label}
        {busy
          ? <Loader2Icon className="size-4 animate-spin" aria-hidden />
          : <ArrowRightIcon className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" aria-hidden />}
      </button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  )
}
