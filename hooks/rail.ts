// The Trips timeline: a rail structure (a tide line, a "now" marker, hour
// labels, gap breaks) dressed in a warm dark token set.
import type { SessionRow } from '../types'

export const TOKENS = {
  raised: '#0b0907',
  overlay: '#1a1612',
  hover: '#f5f0eb0f',
  hair: '#f5f0eb14',
  subtle: '#f5f0eb24',
  primary: '#f5f0eb',
  secondary: '#d4c7ba',
  muted: '#96806e',
  signal: '#24f2e4',
  patina: '#43bfb7',
  /** --color-patina at 10%, the review lamp's fill and the open PR chip. */
  patinaTint: '#43bfb71a',
  /** --color-warning-default and its tint: blocked, waiting on the person. */
  warning: '#e8a33c',
  warningTint: '#e8a33c1f',
}
// Categorical line hues: the rail, the lamp ring and the chip tint (14 % fill).
export const HUES = ['#5e8cd1', '#9b7eca', '#ca6ca6', '#988c54', '#6f975c']

/**
 * A row's signal lamp: blocked (amber), review (teal ring), done (grey ring),
 * running (the host says a turn runs: pulsing signal), live (no host answer,
 * written inside two minutes: the old signal dot), none.
 */
export type Lamp = 'blocked' | 'review' | 'done' | 'running' | 'live' | 'none'

/** A session written to within this long counts as live: "now" and the signal dot. */
export const LIVE_MS = 2 * 60 * 1000
/** Consecutive sessions further apart than this get a gap break between them. */
const GAP_MS = 2 * 3600 * 1000

export type Item =
  | { kind: 'row'; row: SessionRow; isLive: boolean }
  | { kind: 'hour'; label: string }
  | { kind: 'gap'; label: string }

export const hue = (key: string) => {
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length] ?? HUES[0]!
}

const hoursLabel = (ms: number) => {
  const h = Math.round(ms / 3600000)
  return h >= 1 ? `${h} h` : `${Math.round(ms / 60000)} min`
}

/** Newest first, with an hour label at each hour change and a break at each long gap. */
export function layout(rows: SessionRow[], nowMs: number): Item[] {
  const items: Item[] = []
  let prev: SessionRow | undefined
  for (const row of rows) {
    const isLive = nowMs - row.mtimeMs < LIVE_MS
    if (prev && prev.mtimeMs - row.mtimeMs > GAP_MS)
      items.push({ kind: 'gap', label: hoursLabel(prev.mtimeMs - row.mtimeMs) })
    const newHour = prev ? prev.hour !== row.hour || prev.isToday !== row.isToday : !isLive
    if (newHour) items.push({ kind: 'hour', label: row.isToday ? row.hour : `yesterday ${row.hour}` })
    items.push({ kind: 'row', row, isLive })
    prev = row
  }
  return items
}
