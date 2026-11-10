'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Loader2Icon, LogInIcon } from 'lucide-react'
import { LOCAL_DEMO_USER, LOCAL_MODE } from '@/lib/local-mode'
import { BRAND } from '@/lib/brand'
import { StructuraMark } from '@/components/structura-mark'

export default function LoginPage() {
  const [email, setEmail] = useState<string>(LOCAL_MODE ? LOCAL_DEMO_USER.email : '')
  const [password, setPassword] = useState<string>(LOCAL_MODE ? LOCAL_DEMO_USER.password : '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (error) throw error
      router.push('/dashboard')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-grid">
      <Card className="relative z-10 w-full max-w-md shadow-[0_1px_2px_rgba(10,10,10,0.04)] border-border/50 animate-fade-up">
        <CardContent className="pt-10 pb-8 px-8 text-center space-y-8">
          {/* ADU Miniature — small, accent size */}
          <div className="flex justify-center">
            <StructuraMark className="size-12" />
          </div>

          {/* Branding */}
          <div className="space-y-2">
            <h1 className="heading-display text-foreground">{BRAND.name}</h1>
            <p className="text-muted-foreground font-body">{BRAND.descriptor}</p>
          </div>

          {/* Login Form */}
          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="font-body"
              autoComplete="email"
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="font-body"
              autoComplete="current-password"
            />
            <Button
              type="submit"
              disabled={loading}
              className="w-full rounded-none px-8 py-6 font-body text-base font-medium
                         hover:shadow-[0_8px_20px_-8px_rgba(31,59,255,0.45)] hover:brightness-110"
              size="lg"
            >
              {loading ? (
                <Loader2Icon className="w-4 h-4 animate-spin" />
              ) : (
                <LogInIcon className="w-4 h-4" />
              )}
              {loading ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>

          {/* Error */}
          {error && (
            <p className="text-sm text-destructive font-body">{error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
