/** Product identity, in one place. */
export const BRAND = {
  name: 'Structura',
  descriptor: 'Autonomous Civic & Permit Intelligence',
  tagline: 'Open-Weight Multi-Agent Plan Check & Municipal Code Engine on Mozilla Otari',
} as const

/**
 * Source link shown in the header and footer. Set NEXT_PUBLIC_REPO_URL once the
 * structura-otari repository exists; until then this points at the live branch.
 */
export const REPO_URL =
  process.env.NEXT_PUBLIC_REPO_URL || 'https://github.com/bhavya-jpg/cc-crossbeam/tree/feat/otari-gateway'
