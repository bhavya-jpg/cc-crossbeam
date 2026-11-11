import Link from 'next/link'
import { ArrowUpRightIcon } from 'lucide-react'
import { GatewayShowcase } from '@/components/landing/gateway-showcase'
import { Reveal } from '@/components/landing/reveal'
import { OpenWorkspaceButton } from '@/components/open-workspace-button'
import { StructuraMark } from '@/components/structura-mark'
import { BRAND, PUBLIC_SITE, REPO_URL, RUN_LOCALLY_URL } from '@/lib/brand'
import { RUN_FACTS } from '@/lib/recorded-run'

const AGENTS = [
  {
    index: '01',
    role: 'Extractor',
    model: 'Qwen3-VL-235B',
    text: 'Reads the city’s corrections letter and every plan sheet as images, so a scanned letter with no text layer still works.',
  },
  {
    index: '02',
    role: 'Researcher',
    model: 'gpt-oss-120b',
    text: 'Finds the city’s ADU ordinance and the state code each item cites, through Otari web search and fetch or verified local references.',
  },
  {
    index: '03',
    role: 'Analyst',
    model: 'DeepSeek-V4-Pro',
    text: 'Computes setbacks, lot coverage and fee thresholds in an Otari code sandbox, then re-checks its numbers in the same container.',
  },
  {
    index: '04',
    role: 'Drafter',
    model: 'DeepSeek-V4-Pro',
    text: 'Sorts each item into fix now, ask the contractor and needs a professional, then drafts the response letter.',
  },
]

const CONTROLS = [
  { title: 'Routing and failover', text: 'Every role has a backup open-weight model. A refused or failed call moves on, and every attempt is recorded.' },
  { title: 'Guardrails', text: 'Letter text is screened for prompt injection. In block mode the gateway refuses before any model sees it.' },
  { title: 'Code execution', text: 'Spatial checks run in an Otari container, reused across turns, so the numbers are computed rather than guessed.' },
  { title: 'Web search and fetch', text: 'The researcher asks the gateway for live municipal code, and narrows its tools when a workspace turns them off.' },
  { title: 'MCP', text: 'California ADU law is an MCP server the gateway calls directly, with a local tool loop when it can’t reach it.' },
  { title: 'Per-contractor budgets', text: 'Each run spends on its contractor’s own key. A spent ceiling stops the run with a hold, not a bill.' },
]

const FIGURES = [
  [String(RUN_FACTS.items), 'correction items read'],
  [String(RUN_FACTS.calls), 'gateway calls'],
  [`$${RUN_FACTS.costUsd.toFixed(2)}`, 'spend reported by Otari'],
  [RUN_FACTS.duration, 'from letter to questions'],
] as const

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <StructuraMark className="size-5" />
          <span className="font-display text-xl tracking-[-0.01em]">{BRAND.name}</span>
        </Link>
        <div className="flex items-center gap-1 text-sm">
          <a href="#schedule" className="hidden px-3 py-2 text-muted-foreground transition-colors hover:text-foreground sm:block">How it works</a>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-3 py-2 text-muted-foreground transition-colors hover:text-foreground">
            Source <ArrowUpRightIcon className="size-3.5" aria-hidden />
          </a>
          <Link href={PUBLIC_SITE ? RUN_LOCALLY_URL : '/dashboard'} className="ml-2 inline-flex h-9 items-center rounded-md border border-border px-3.5 font-medium transition-colors hover:border-foreground/30">
            {PUBLIC_SITE ? 'Run locally' : 'Dashboard'}
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <header className="mx-auto max-w-6xl px-4 pb-20 pt-20 sm:px-6 lg:px-8 lg:pt-28">
        <p className="eyebrow animate-fade-up">{BRAND.descriptor}</p>
        <h1 className="mt-5 max-w-4xl font-display text-[clamp(2.75rem,6.5vw,5.75rem)] leading-[1.02] tracking-[-0.03em] animate-fade-up stagger-1">
          Plan check that <em className="text-primary">shows its work.</em>
        </h1>
        <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground animate-fade-up stagger-2">
          {BRAND.name} reads a city&apos;s corrections letter and the plan set, checks each item against California ADU
          law and local code, and drafts the response, on open-weight models routed through Mozilla Otari.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3 animate-fade-up stagger-3">
          <OpenWorkspaceButton />
          <a href="#schedule" className="inline-flex h-11 items-center rounded-md border border-border px-5 text-sm font-medium transition-colors hover:border-foreground/30">
            See the run, call by call
          </a>
        </div>

        <dl className="mt-20 grid grid-cols-2 gap-y-10 border-t border-border pt-8 lg:grid-cols-4 animate-fade-up stagger-4">
          {FIGURES.map(([value, label]) => (
            <div key={label} className="pr-6">
              <dd className="text-4xl font-medium tracking-[-0.03em] tabular-nums sm:text-5xl">{value}</dd>
              <dt className="mt-2 text-sm text-muted-foreground">{label}</dt>
            </div>
          ))}
        </dl>
      </header>

      {/* Schedule */}
      <section id="schedule" className="scroll-mt-6 border-t border-border bg-secondary/50">
        <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
          <SectionHead index="01" label="The run">
            Live Otari Gateway Architecture &amp; Multi-Model Telemetry
          </SectionHead>
          <p className="mt-5 max-w-2xl text-muted-foreground">
            Every call from the first fully live run, on a real Placentia corrections letter. Pick an agent to see its
            model, provider and calls, or replay the run at 60&times;.
          </p>
          <Reveal className="mt-10">
            <GatewayShowcase />
          </Reveal>
        </div>
      </section>

      {/* Agents */}
      <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
        <SectionHead index="02" label="Agents">Four agents, three open-weight models</SectionHead>
        <ol className="mt-12 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
          {AGENTS.map(({ index, role, model, text }, i) => (
            <li key={index}>
              <Reveal delay={i * 70} className="border-t border-foreground pt-5">
                <p className="readout text-xs text-muted-foreground">{index}</p>
                <h3 className="mt-3 font-display text-3xl tracking-[-0.02em]">{role}</h3>
                <p className="readout mt-2 inline-block rounded bg-primary/[0.07] px-2 py-0.5 text-xs text-primary">{model}</p>
                <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">{text}</p>
              </Reveal>
            </li>
          ))}
        </ol>
      </section>

      {/* Control plane */}
      <section className="border-t border-border">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[1fr_1.6fr] lg:px-8">
          <div>
            <SectionHead index="03" label="Control plane">The gateway is part of the product</SectionHead>
            <p className="mt-5 max-w-sm leading-relaxed text-muted-foreground">
              Permit work needs an audit trail. The workspace&apos;s Inspector shows which model and provider served each
              call, what the guardrail said, which sandbox ran the numbers and what it cost.
            </p>
          </div>
          <ul className="grid gap-x-10 sm:grid-cols-2">
            {CONTROLS.map(({ title, text }, i) => (
              <li key={title} className="border-t border-border py-6">
                <Reveal delay={(i % 2) * 70}>
                  <h3 className="flex items-baseline gap-3 font-medium">
                    <span className="readout text-xs text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                    {title}
                  </h3>
                  <p className="mt-2 pl-8 text-[15px] leading-relaxed text-muted-foreground">{text}</p>
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Call to action */}
      <section className="bg-foreground text-background">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-4 py-20 sm:px-6 md:flex-row md:items-end lg:px-8">
          <div>
            <p className="text-sm text-background/60">A real second-round corrections letter for a 600 sq ft detached ADU</p>
            <h2 className="mt-3 max-w-2xl font-display text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] tracking-[-0.025em]">
              Open the Placentia review, with the Inspector beside it.
            </h2>
          </div>
          <OpenWorkspaceButton label="Open the review" />
        </div>
      </section>

      {/* Footer */}
      <footer className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-2.5">
          <StructuraMark className="size-4" />
          <span className="text-foreground">{BRAND.name}</span>
          <span>· MIT License · Inference by Mozilla Otari</span>
        </div>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 transition-colors hover:text-foreground">
          Source code <ArrowUpRightIcon className="size-3.5" aria-hidden />
        </a>
      </footer>
    </div>
  )
}

function SectionHead({ index, label, children }: { index: string; label: string; children: React.ReactNode }) {
  return (
    <Reveal>
      <p className="text-sm text-muted-foreground">
        <span className="readout text-primary">{index}</span>
        <span className="mx-2 text-border">/</span>
        {label}
      </p>
      <h2 className="mt-3 max-w-3xl font-display text-[clamp(2rem,4vw,3.25rem)] leading-[1.08] tracking-[-0.025em]">{children}</h2>
    </Reveal>
  )
}
