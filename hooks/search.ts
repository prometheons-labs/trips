// Depot search: one field above the Sidings filters the parked sessions
// (Sidings and Depot) by title, group, branch or folder as the person types.
import type { SessionRow } from '../types'

export const SEARCH_PLACEHOLDER = 'Find a parked session'

/** Every word of the query appears in the title, group, branch or folder, case folded. */
export function matches(row: SessionRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = [row.title, row.groupName, row.branch, row.project].join(' ').toLowerCase()
  return words.every(w => hay.includes(w))
}

export type Parked = { resting: SessionRow[]; archive: SessionRow[]; isSearching: boolean; total: number }

/** The Sidings and Depot rows that match; both open while a query is typed. */
export function searchParked(resting: readonly SessionRow[], archive: readonly SessionRow[], query: string): Parked {
  const isSearching = query.trim().length > 0
  const r = resting.filter(row => matches(row, query))
  const a = archive.filter(row => matches(row, query))
  return { resting: r, archive: a, isSearching, total: r.length + a.length }
}

/** The one muted line that replaces the list when nothing matches. */
export const noMatchLine = (query: string) => `No parked session matches "${query.trim()}".`
