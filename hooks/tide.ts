// The tide applied to single sessions, in metro
// words: on the rail under 24 h, in the Sidings from 24 h to 7 days (parked off
// the main line, ready to come back), in the Depot past 7 days or once archived.
import type { SessionRow } from '../types'
import { LIVE_MS } from './rail'

const HOUR = 3600 * 1000
export const AWAKE_MS = 24 * HOUR
export const RESTING_MS = 7 * 24 * HOUR
/** Rows drawn per step in the Sidings, and the fixed cap in the Depot. */
export const SHOWN_STEP = 30

export type Tides = { awake: SessionRow[]; resting: SessionRow[]; archive: SessionRow[] }

/** Desktop sessions only, newest first within each tide. */
export function tide(rows: SessionRow[], nowMs: number): Tides {
  const out: Tides = { awake: [], resting: [], archive: [] }
  const sorted = rows.filter(r => r.localId).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const row of sorted) {
    const age = nowMs - row.mtimeMs
    if (row.isArchived || age > RESTING_MS) out.archive.push(row)
    else if (age > AWAKE_MS) out.resting.push(row)
    else out.awake.push(row)
  }
  return out
}

export const isLive = (row: SessionRow, nowMs: number) => nowMs - row.mtimeMs < LIVE_MS

/** "live", HH:MM today, "yesterday", or the weekday short name. */
export function timeLabel(row: SessionRow, nowMs: number): string {
  if (isLive(row, nowMs)) return 'live'
  if (row.daysAgo <= 0) return row.clock
  if (row.daysAgo === 1) return 'yesterday'
  return row.weekday
}

/** Archive age: "today", "yesterday", "N d". */
export function ageLabel(row: SessionRow): string {
  if (row.daysAgo <= 0) return 'today'
  if (row.daysAgo === 1) return 'yesterday'
  return `${row.daysAgo} d`
}

export type FolderGroup = { project: string; rows: SessionRow[] }

/**
 * Groups rows by project folder. Folders run by their newest session, and rows
 * inside a folder run newest first. Takes the newest `limit` rows overall first.
 */
export function byFolder(rows: SessionRow[], limit: number): FolderGroup[] {
  const groups = new Map<string, SessionRow[]>()
  for (const row of [...rows].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)) {
    const key = row.project || 'other'
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  // Map keeps insertion order, and rows were inserted newest first.
  return [...groups].map(([project, list]) => ({ project, rows: list }))
}
