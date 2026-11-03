/**
 * Read-only access to the ADU law skills on disk. Used by the drafter's prompts,
 * its local tool loop, and the MCP endpoint, so all three see the same text.
 *
 * Documents are addressed only by ids from an index built at load time, so no
 * caller-supplied string is ever joined into a file path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ONBOARDED_CITIES } from '../utils/config.js';

const SKILLS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../skills');

/** Skills that hold law text, as opposed to workflow instructions. */
export const LAW_SKILLS = ['california-adu', ...Object.values(ONBOARDED_CITIES)];

export interface ReferenceDoc {
  id: string;
  skill: string;
  title: string;
  relevance: string;
  text: string;
}

let library: Map<string, ReferenceDoc> | null = null;

function frontmatterField(text: string, field: string): string {
  const match = text.match(new RegExp(`^${field}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function loadLibrary(): Map<string, ReferenceDoc> {
  if (library) return library;
  library = new Map();
  for (const skill of LAW_SKILLS) {
    const skillDir = path.join(SKILLS_ROOT, skill);
    const referencesDir = path.join(skillDir, 'references');
    const files = [
      { id: `${skill}/SKILL`, filePath: path.join(skillDir, 'SKILL.md') },
      ...(fs.existsSync(referencesDir) ? fs.readdirSync(referencesDir) : [])
        .filter((name) => name.endsWith('.md'))
        .map((name) => ({ id: `${skill}/${name.replace(/\.md$/, '')}`, filePath: path.join(referencesDir, name) })),
    ];
    for (const { id, filePath } of files) {
      if (!fs.existsSync(filePath)) continue;
      const text = fs.readFileSync(filePath, 'utf-8');
      library.set(id, {
        id,
        skill,
        title: frontmatterField(text, 'title') || frontmatterField(text, 'name') || id,
        relevance: frontmatterField(text, 'relevance') || frontmatterField(text, 'description'),
        text,
      });
    }
  }
  return library;
}

export function listReferences(skill?: string): Array<Pick<ReferenceDoc, 'id' | 'title' | 'relevance'>> {
  return [...loadLibrary().values()]
    .filter((doc) => !skill || doc.skill === skill)
    .map(({ id, title, relevance }) => ({ id, title, relevance }));
}

export function readReference(id: string): ReferenceDoc | null {
  return loadLibrary().get(id) ?? null;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'shall', 'are', 'not', 'per', 'all', 'any', 'adu', 'adus', 'plan', 'plans', 'sheet']);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9.]{3,}/g) ?? []).filter((token) => !STOPWORDS.has(token));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < 5; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

export interface ReferenceMatch {
  id: string;
  title: string;
  score: number;
  snippet: string;
}

/** Deterministic keyword ranking; title and relevance hits weigh more than body hits. */
export function searchReferences(query: string, options: { skills?: string[]; limit?: number } = {}): ReferenceMatch[] {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  const matches: ReferenceMatch[] = [];
  for (const doc of loadLibrary().values()) {
    if (options.skills && !options.skills.includes(doc.skill)) continue;
    const heading = `${doc.id} ${doc.title} ${doc.relevance}`.toLowerCase();
    const body = doc.text.toLowerCase();
    let score = 0;
    let firstHit = -1;
    for (const token of tokens) {
      score += countOccurrences(heading, token) * 5 + countOccurrences(body, token);
      const at = body.indexOf(token);
      if (at !== -1 && (firstHit === -1 || at < firstHit)) firstHit = at;
    }
    if (score > 0) {
      const start = Math.max(0, firstHit - 120);
      matches.push({ id: doc.id, title: doc.title, score, snippet: doc.text.slice(start, start + 400).trim() });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, options.limit ?? 5);
}

/** The documents most relevant to `query`, for inlining into a prompt. */
export function selectReferences(
  query: string,
  skills: string[],
  options: { limit: number; maxCharsEach: number },
): Array<{ id: string; text: string }> {
  return searchReferences(query, { skills, limit: options.limit }).map(({ id }) => ({
    id,
    text: (readReference(id)?.text ?? '').slice(0, options.maxCharsEach),
  }));
}

/** A workflow document from any skill, e.g. a flow's SKILL.md or output schema. */
export function readWorkflowDoc(relativePath: string, maxChars: number): string {
  const filePath = path.join(SKILLS_ROOT, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').slice(0, maxChars) : '';
}
