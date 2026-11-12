// Lines by sidebar group: the desktop app's own groups colour the rail and
// filter the pane. The groups and their order come from the desktop config.
import type { SessionRow, SidebarGroup } from '../types'
import { HUES, hue } from './rail'

/** The filter value for every group, and the Select's "Select one" option. */
export const ALL = 'ALL'
export const SELECT_PLACEHOLDER = 'Select one'

/** A stored filter that names a group no longer in the sidebar reads as All. */
export const validFilter = (filter: unknown, groups: readonly SidebarGroup[]): string =>
  typeof filter === 'string' && groups.some(g => g.id === filter) ? filter : ALL

export const inGroup = (row: SessionRow, filter: string) => filter === ALL || row.groupId === filter

/** The line colour: the group's place in the sidebar, else the folder's hash, as in 0.4. */
export function colourOf(row: SessionRow, groups: readonly SidebarGroup[]): string {
  const at = row.groupId ? groups.findIndex(g => g.id === row.groupId) : -1
  return at >= 0 ? HUES[at % HUES.length]! : hue(row.project || row.title)
}

export const groupColour = (id: string, groups: readonly SidebarGroup[]): string => {
  const at = groups.findIndex(g => g.id === id)
  return at >= 0 ? HUES[at % HUES.length]! : HUES[0]!
}

export type GroupStat = SidebarGroup & { trips: number; waiting: number }

/**
 * Each sidebar group, in sidebar order, with its trips (rail rows of the last
 * 24 h that do not wait) and its waiting rows (every Platform row).
 */
export function groupStats(groups: readonly SidebarGroup[], trips: readonly SessionRow[], waiting: readonly SessionRow[]): GroupStat[] {
  return groups.map(g => ({
    ...g,
    trips: trips.filter(r => r.groupId === g.id).length,
    waiting: waiting.filter(r => r.groupId === g.id).length,
  }))
}

/** "QUOTEFORGE · 3 · 1 waiting": the parts that are zero are left out. */
export const optionLabel = (s: GroupStat) =>
  s.name + (s.trips ? ` · ${s.trips}` : '') + (s.waiting ? ` · ${s.waiting} waiting` : '')

export type Elsewhere = { count: number; names: string[] }

/** Waiting rows outside the filter, and their group names in sidebar order. */
export function elsewhere(waiting: readonly SessionRow[], filter: string, groups: readonly SidebarGroup[]): Elsewhere {
  if (filter === ALL) return { count: 0, names: [] }
  const out = waiting.filter(r => r.groupId !== filter)
  const ids = new Set(out.map(r => r.groupId))
  const names = groups.filter(g => ids.has(g.id)).map(g => g.name)
  if (ids.has('')) names.push('no group')
  return { count: out.length, names }
}

/** "2 more waiting in LANTERN, QUOTEFORGE". */
export const elsewhereLine = (e: Elsewhere) => `${e.count} more waiting in ${e.names.join(', ')}`
