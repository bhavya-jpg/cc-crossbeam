/** A beam across a square: the mark. */
export function StructuraMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="1.5" fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.5" />
      <path d="M6 18L18 6" stroke="#1F3BFF" strokeWidth="2.4" strokeLinecap="square" />
    </svg>
  )
}
