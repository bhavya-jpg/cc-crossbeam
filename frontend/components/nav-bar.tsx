'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import {
  LogOutIcon,
  ChevronDownIcon,
  WrenchIcon,
  EyeIcon,
  RocketIcon,
  LayoutGridIcon,
  BookOpenIcon,
  GitBranchIcon,
} from 'lucide-react'
import { StructuraMark } from '@/components/structura-mark'
import { BRAND, REPO_URL } from '@/lib/brand'
import { useAppMode } from '@/hooks/use-app-mode'
import { setAppMode, type AppMode } from '@/lib/app-mode'

interface NavBarProps {
  userEmail: string
}

const MODE_CONFIG: Record<AppMode, { label: string; icon: typeof WrenchIcon }> = {
  'dev-test': { label: 'Dev Test', icon: WrenchIcon },
  'judge-demo': { label: 'Judge Demo', icon: EyeIcon },
  'real': { label: 'Real', icon: RocketIcon },
}

export function NavBar({ userEmail }: NavBarProps) {
  const router = useRouter()
  const mode = useAppMode()

  const handleSignOut = async () => {
    await fetch('/auth/signout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  const handleModeChange = (value: string) => {
    setAppMode(value as AppMode)
    router.push('/dashboard')
    router.refresh()
  }

  const ModeIcon = MODE_CONFIG[mode].icon

  const cell = 'flex items-center gap-1.5 px-3 text-sm text-muted-foreground transition-colors hover:text-foreground'
  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-stretch justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <StructuraMark className="size-5" />
          <span className="font-display text-xl leading-none tracking-[-0.01em] text-foreground">{BRAND.name}</span>
        </Link>

        <div className="flex items-stretch">
          <Link href="/my-projects" className={cell}>
            <LayoutGridIcon className="size-3.5" />
            <span className="hidden sm:inline">Projects</span>
          </Link>
          <Link href="/" className={cell}>
            <BookOpenIcon className="size-3.5" />
            <span className="hidden sm:inline">How it works</span>
          </Link>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={cell}>
            <GitBranchIcon className="size-3.5" />
            <span className="hidden sm:inline">Source</span>
          </a>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={`${cell} pr-0`}>
                <ModeIcon className="size-3.5 text-primary" />
                <span className="hidden sm:inline">{userEmail}</span>
                <ChevronDownIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Mode</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={mode} onValueChange={handleModeChange}>
                {Object.entries(MODE_CONFIG).map(([key, { label, icon: Icon }]) => (
                  <DropdownMenuRadioItem key={key} value={key} className="gap-2">
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut} variant="destructive">
                <LogOutIcon className="w-3.5 h-3.5" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </nav>
  )
}
