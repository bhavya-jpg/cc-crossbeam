import { NextRequest, NextResponse } from 'next/server'
import { forwardToOtariServer } from '@/lib/otari-proxy'

const CONVERSATION_ID = /^crossbeam-(?:demo-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params
  const projectId = CONVERSATION_ID.exec(conversationId)?.[1]
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid conversation ID' }, { status: 400 })
  }
  return forwardToOtariServer(request, projectId, `/api/otari/traces/${conversationId}`, {
    method: 'GET',
    timeoutMs: 30_000,
  })
}
