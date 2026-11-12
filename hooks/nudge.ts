// The flip nudge: when a session flips to blocked between two scans, one toast
// once per flip (never for this session, never on review_ready), and the pane
// title counts the waiting rows.
import type { SessionRow } from '../types'
import { flipKey } from './platform'

/** Announced flips kept in `$.store`, newest last, so a reload or another session stays quiet. */
export const ANNOUNCED_MAX = 300

export type Flips = { toast: SessionRow[]; announced: string[] }

/**
 * The rows that flipped to blocked since `prev`, not yet announced, not the
 * current session. An empty `prev` is the first look: nothing flipped yet.
 */
export function flips(prev: readonly SessionRow[], next: readonly SessionRow[], announced: readonly string[], currentId: string): Flips {
  const seen = new Set(announced)
  const out: string[] = [...announced]
  const toast: SessionRow[] = []
  if (prev.length === 0) return { toast, announced: out }
  const before = new Map(prev.map(r => [r.id, r]))
  for (const row of next) {
    if (row.status !== 'blocked' || row.isArchived || !row.localId || row.id === currentId) continue
    const key = flipKey(row)
    if (seen.has(key)) continue
    const was = before.get(row.id)
    if (was && was.status === 'blocked' && was.summaryId === row.summaryId) continue
    seen.add(key)
    out.push(key)
    toast.push(row)
  }
  return { toast, announced: out.slice(-ANNOUNCED_MAX) }
}

/** "Dispatch Desk route planner is waiting on you: approve the plan". */
export const toastText = (row: SessionRow) =>
  `${row.title} is waiting on you${row.nextAction ? `: ${row.nextAction}` : '.'}`

/** "Trips · 3 waiting", or plain "Trips" with none. */
export const paneTitle = (waiting: number) => (waiting > 0 ? `Trips · ${waiting} waiting` : 'Trips')
