// Parking: a Trips-only Depot mark. It makes no host call, so it neither stops
// nor archives the app's session. A parked trip shows in the Depot and leaves
// every waiting count, until the session asks again (a new summary, or a
// message after the mark), which clears the mark.
import type { SessionRow } from '../types'

export type ParkMark = { at: number; summaryId: string }
/** By the desktop `local_` id. */
export type Parked = Record<string, ParkMark>

/** One parked row's Undo window, by row id. */
export type UndoPark = { id: string; localId: string; title: string; until: number }

/** The Undo row stands in the parked row's place this long. */
export const UNDO_MS = 8000

/** The session asked again since the mark: a new summary, or activity after it. */
export const isStale = (row: SessionRow, mark: ParkMark) => row.summaryId !== mark.summaryId || row.mtimeMs > mark.at

export const isParked = (row: SessionRow, parked: Readonly<Parked>) => {
  const mark = row.localId ? parked[row.localId] : undefined
  return !!mark && !isStale(row, mark)
}

/** The local ids whose mark the session has outgrown: they come back as normal. */
export function staleMarks(rows: readonly SessionRow[], parked: Readonly<Parked>): string[] {
  const byLocal = new Map(rows.filter(r => r.localId).map(r => [r.localId, r]))
  return Object.entries(parked)
    .filter(([localId, mark]) => {
      const row = byLocal.get(localId)
      return !!row && isStale(row, mark)
    })
    .map(([localId]) => localId)
}

/**
 * Rows as Trips shows them: a parked row reads as in the Depot (isArchived),
 * except while its Undo row is up, where it keeps its place.
 */
export function applyParks(rows: SessionRow[], parked: Readonly<Parked>, undo: readonly UndoPark[]): SessionRow[] {
  if (!undo.length && !Object.keys(parked).length) return rows
  const holding = new Set(undo.map(u => u.id))
  return rows.map(r => (holding.has(r.id) ? { ...r, isArchived: false } : isParked(r, parked) ? { ...r, isArchived: true } : r))
}

/** Ids that never count as waiting: parked ones and those with their Undo row up. */
export function parkedIds(rows: readonly SessionRow[], parked: Readonly<Parked>, undo: readonly UndoPark[]): Set<string> {
  const out = new Set(undo.map(u => u.id))
  for (const r of rows) if (isParked(r, parked)) out.add(r.id)
  return out
}

export const parkedMap = (v: unknown): Parked => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Parked = {}
  for (const [k, m] of Object.entries(v as Record<string, unknown>)) {
    const mark = m as Partial<ParkMark> | null
    if (mark && typeof mark.at === 'number' && typeof mark.summaryId === 'string') out[k] = { at: mark.at, summaryId: mark.summaryId }
  }
  return out
}

export const undoList = (v: unknown): UndoPark[] =>
  Array.isArray(v) ? v.filter((p): p is UndoPark => !!p && typeof p.id === 'string' && typeof p.localId === 'string' && typeof p.until === 'number') : []
