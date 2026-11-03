import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, getSupabaseForAuth } from '@/lib/api-auth'

/**
 * Forwards an Inspector call to the server after the same access check as /api/generate:
 * the signed-in user owns the project, or it's a demo project.
 */
export async function forwardToOtariServer(
  request: NextRequest,
  projectId: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<NextResponse> {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!auth.isApiKey) {
    const supabase = await getSupabaseForAuth(auth)
    const { data: project } = await supabase
      .schema('crossbeam')
      .from('projects')
      .select('user_id, is_demo')
      .eq('id', projectId)
      .single()
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (project.user_id !== auth.userId && !project.is_demo) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
  }

  const serverUrl = process.env.CLOUD_RUN_URL
  if (!serverUrl) {
    return NextResponse.json({ error: 'Server not configured: CLOUD_RUN_URL is not set' }, { status: 500 })
  }

  const token = process.env.OTARI_INSPECTOR_TOKEN
  try {
    const response = await fetch(`${serverUrl}${path}`, {
      method: init.method,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs),
    })
    const data = await response.json().catch(() => ({ error: `Server error: ${response.status}` }))
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: `Could not reach the server: ${message}` }, { status: 502 })
  }
}
