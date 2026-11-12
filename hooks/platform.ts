// The Platform: sessions that wait on the person, lifted above "now", and the
// per-row signals (lamp, line 2, chips, fuel) that say what each row needs.
import type { SessionRow } from '../types'
import type { Lamp } from './rail'

/** Rows drawn on the Platform before the "+N more waiting" line. */
export const PLATFORM_MAX = 5
/** Context share at which the fuel gauge turns amber and asks for a handoff. */
export const FUEL_HOT = 80
export const HANDOFF_LINE = 'hand off before compaction'
/** Shown only after a reply could not be delivered by either route. */
export const NOT_RUNNING_LINE = 'Not running, so it cannot take a reply. Open it to answer.'

/** What a row's waiting state is judged against: Done marks and the host's running map. */
export type Signals = {
  dismissed: ReadonlySet<string>
  /**
   * isRunning by `local_` id: true while a turn runs now (the host's meaning,
   * checked live 2026-11-07); null when the host did not answer.
   */
  running: Readonly<Record<string, boolean>> | null
}

/** One key per summary: a Done mark holds until the session writes a new summary. */
export const flipKey = (row: SessionRow) => `${row.id}:${row.summaryId}`

/** A turn runs now: true, false, or undefined when the host did not list the session. */
export const isRunning = (row: SessionRow, s: Signals): boolean | undefined => {
  if (s.running === null || !(row.localId in s.running)) return undefined
  return s.running[row.localId] === true
}

/**
 * Blocked by the app's own summary, not archived, not marked Done. A blocked
 * session is idle by nature, so isRunning never takes it off the Platform.
 */
export function isWaiting(row: SessionRow, s: Signals): boolean {
  return row.status === 'blocked' && !!row.localId && !row.isArchived && !s.dismissed.has(flipKey(row))
}

/** The lamp: waiting first, then a running turn, then the summary category. */
export function lampOf(row: SessionRow, s: Signals, isLive: boolean): Lamp {
  if (isWaiting(row, s)) return 'blocked'
  const running = isRunning(row, s)
  if (running === true) return 'running'
  if (running === undefined && isLive) return 'live'
  if (row.status === 'review_ready') return 'review'
  if (row.status === 'completed' || row.status === 'blocked') return 'done'
  return 'none'
}

export type PlatformView = {
  /** Every waiting row, newest first. */
  waiting: SessionRow[]
  /** The rows drawn: the newest five, or all once opened. */
  shown: SessionRow[]
  /** How many wait beyond the shown rows. */
  more: number
  /** Days since the oldest waiting row was written, for the "+N more" line. */
  oldestDays: number
}

/** The Platform of the given rows (filter them first): newest first, max five unless opened. */
export function platform(rows: SessionRow[], s: Signals, isOpen = false, max = PLATFORM_MAX): PlatformView {
  const waiting = rows.filter(r => isWaiting(r, s)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const shown = isOpen ? waiting : waiting.slice(0, max)
  const oldest = waiting[waiting.length - 1]
  return { waiting, shown, more: waiting.length - shown.length, oldestDays: oldest ? oldest.daysAgo : 0 }
}

export type Line2 = { tone: 'ask' | 'recap' | 'prompt' | 'none'; text: string }

/** Line 2: the ask on a waiting row, else the recap, else the last prompt. */
export function line2(row: SessionRow, s: Signals): Line2 {
  if (isWaiting(row, s) && row.nextAction) return { tone: 'ask', text: row.nextAction }
  if (row.recap) return { tone: 'recap', text: row.recap }
  if (row.lastPrompt) return { tone: 'prompt', text: `You: ${row.lastPrompt}` }
  return { tone: 'none', text: '' }
}

export type PrChip = { key: string; label: string; url: string; isOpen: boolean }

/** PR chips: open ones first, then the newest merged or closed, two at most. */
export function prChips(row: SessionRow, max = 2): PrChip[] {
  const open = row.prs.filter(p => p.state === 'open')
  const rest = row.prs.filter(p => p.state !== 'open').sort((a, b) => b.prNumber - a.prNumber)
  return [...open, ...rest].slice(0, max).map(p => ({
    key: `pr:${row.id}:${p.prNumber}`,
    label: `#${p.prNumber} ${p.state || 'pr'}`,
    url: p.url,
    isOpen: p.state === 'open',
  }))
}

export type Fuel = { percent: number; isHot: boolean }

/** The fuel gauge from `$.session.usage()`'s context percent; none before the first response. */
export function fuelOf(percent: number | undefined): Fuel | undefined {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
  const p = Math.round(Math.max(0, Math.min(100, percent)))
  return { percent: p, isHot: p >= FUEL_HOT }
}

/** "+3 more waiting, oldest 9 d". */
export function moreLine(view: PlatformView): string {
  const age = view.oldestDays <= 0 ? 'today' : view.oldestDays === 1 ? 'yesterday' : `${view.oldestDays} d`
  return `+${view.more} more waiting, oldest ${age}`
}

/**
 * Fills the fields 0.5 added on a row stored by an older version (shape
 * migration), so a 0.4.2 row in the store draws instead of throwing.
 */
export function normaliseRow(raw: unknown): SessionRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<SessionRow> & Record<string, unknown>
  if (typeof r.id !== 'string') return undefined
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const status = r.status === 'blocked' || r.status === 'review_ready' || r.status === 'completed' ? r.status : ''
  return {
    ...(r as SessionRow),
    localId: str(r.localId), title: str(r.title) || r.id.slice(0, 8), project: str(r.project), lastPrompt: str(r.lastPrompt),
    status, nextAction: str(r.nextAction), summaryId: str(r.summaryId), recap: str(r.recap), wrapUp: str(r.wrapUp), report: str(r.report), detail: str(r.detail),
    groupId: str(r.groupId), groupName: str(r.groupName), branch: str(r.branch), worktreePath: str(r.worktreePath),
    prs: Array.isArray(r.prs) ? r.prs.filter(p => p && typeof p === 'object' && typeof p.prNumber === 'number') : [],
    isArchived: r.isArchived === true, isStarred: r.isStarred === true,
  }
}

export const normaliseRows = (raw: unknown): SessionRow[] =>
  Array.isArray(raw) ? raw.map(normaliseRow).filter((r): r is SessionRow => !!r) : []
