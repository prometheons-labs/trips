// The chip in the band above the prompt: the tram mark, how many sessions wait, and the eye.
import type { SessionRow } from '../types'
import { TOKENS } from './rail'

export type BandView = { count: number; newest: string }

/**
 * From the Platform's waiting rows (newest first) and every scanned row: the
 * count, and the latest trip's title. That is the newest waiting session, else
 * the session with the most recent activity, else nothing.
 */
export const bandView = (waiting: readonly SessionRow[], rows: readonly SessionRow[] = []): BandView => {
  const latest = rows.reduce<SessionRow | undefined>((best, r) => (!best || r.mtimeMs > best.mtimeMs ? r : best), undefined)
  return { count: waiting.length, newest: waiting[0]?.title ?? latest?.title ?? '' }
}

/** The terminal's tram mark, and the hourglass the waiting count sits behind. */
export const TRAM_GLYPH = '\u{1F68B}'
export const HOURGLASS = '\u23F3'

/** The pill's count text, glyphs only: `⏳ 0`, `⏳ 3`. The title stays in the pane. */
export const countText = (count: number): string => `${HOURGLASS} ${count}`

/** The tram mark, 16 px, in the secondary text colour: a car on a rail with a pantograph. */
export const TRAM_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${TOKENS.secondary}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M6 1.5h4M8 1.5v2"/><rect x="3.5" y="3.5" width="9" height="9" rx="2"/><path d="M3.5 8h9"/>` +
  `<path d="M5.5 12.5l-1.5 2M10.5 12.5l1.5 2"/></svg>`

/**
 * What the band beneath answered draws nothing of its own: no node, or the
 * engine's own placeholder (`{ type: 'engine' }`), which a hook that draws
 * has always dropped.
 */
export const isNothing = (node: unknown): boolean =>
  node === null || node === undefined || node === false || (typeof node === 'object' && (node as { type?: unknown }).type === 'engine')
