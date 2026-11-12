// Test fixtures only: rows and groups shaped as the 0.5 scanner prints them,
// with fictional names.
import type { SessionRow, SidebarGroup } from '../types'

export const NOW = 1_800_000_000_000
export const H = 3600 * 1000

export const GROUPS: SidebarGroup[] = [
  { id: 'cg-ledger', name: 'LEDGERLOOP' },
  { id: 'cg-quote', name: 'QUOTEFORGE' },
  { id: 'cg-dispatch', name: 'DISPATCH DESK' },
  { id: 'cg-eval', name: 'EVAL BENCH' },
  { id: 'cg-triage', name: 'TRIAGE AGENT' },
  { id: 'cg-lantern', name: 'LANTERN' },
]

const nameOf = (id: string) => GROUPS.find(g => g.id === id)?.name ?? ''

/** A desktop row `minsAgo` minutes old; `extra` overrides any field. */
export function row(id: string, minsAgo: number, extra: Partial<SessionRow> = {}): SessionRow {
  const groupId = extra.groupId ?? ''
  const daysAgo = Math.floor(minsAgo / (24 * 60))
  return {
    id, localId: `local_${id}`, title: `Session ${id}`, project: 'tools', lastPrompt: '',
    mtimeMs: NOW - minsAgo * 60000, clock: '10:15', hour: '10:00', isToday: daysAgo === 0,
    daysAgo, weekday: 'Sat', parentLocalId: '', createdAtMs: 0, isArchived: false, isStarred: false,
    status: '', nextAction: '', summaryId: `sum-${id}`, recap: '', groupName: nameOf(groupId),
    branch: '', prs: [], worktreePath: '',
    ...extra,
    groupId,
  }
}

export const blocked = (id: string, minsAgo: number, ask: string, extra: Partial<SessionRow> = {}) =>
  row(id, minsAgo, { status: 'blocked', nextAction: ask, ...extra })
