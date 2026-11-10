/**
 * True when the app runs against server/src/local/supabase-compat.ts. That stand-in has
 * no Realtime, so components poll instead of subscribing.
 */
export const LOCAL_MODE = process.env.NEXT_PUBLIC_CROSSBEAM_LOCAL_MODE === 'true'
export const LOCAL_POLL_MS = 1500

/** The local stand-in's only account. It refuses to run in production. */
export const LOCAL_DEMO_USER = { email: 'judge@structura.local', password: 'structura-local' } as const
