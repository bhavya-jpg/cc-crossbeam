import { NextRequest, NextResponse } from 'next/server'
import { forwardToOtariServer } from '@/lib/otari-proxy'

export async function POST(request: NextRequest) {
  const { project_id: projectId, scenario } = await request.json().catch(() => ({}))
  if (typeof projectId !== 'string' || typeof scenario !== 'string') {
    return NextResponse.json({ error: 'project_id and scenario are required' }, { status: 400 })
  }
  return forwardToOtariServer(request, projectId, '/api/otari/demo', {
    method: 'POST',
    body: { project_id: projectId, scenario },
    timeoutMs: 120_000,
  })
}
