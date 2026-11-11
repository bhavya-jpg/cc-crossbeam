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

/**
 * Public site mode, for a hosted build with no data store or agent server behind it: the landing
 * page works in full, and the workspace links send people to the run-it-locally instructions.
 */
export const PUBLIC_SITE = process.env.NEXT_PUBLIC_STRUCTURA_PUBLIC_SITE === 'true'
export const RUN_LOCALLY_URL = `${REPO_URL}#run-it-locally`
