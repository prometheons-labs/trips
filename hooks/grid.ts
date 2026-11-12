// The Trips grid: a 4 px base, measured from the approved wireframe.
//
// Box spacing on desktop: a number is character cells (one cell is a whole
// line tall), a step name is the desktop's own spacing scale. So every padding
// and gap here is a step name, read as the 4 px multiples below, or 0.
import { TOKENS } from './rail'
import type { Lamp } from './rail'

export const STEP_PX = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
export type Step = keyof typeof STEP_PX

/** 4 px: inside a row (title, line 2, chips) and between chips. */
export const S4: Step = 'xs'
/** 8 px: between rows (4 above, 4 below), the rail-to-content gap, the pane edge. */
export const S8: Step = 'sm'
/** 12 px: above a section label (PLATFORM, now, an hour). */
export const S12: Step = 'md'

/** The rail column: fixed width, the rail line on its centre. */
export const RAIL_W = 24
export const RAIL_X = 12
/** The lamp's centre: the row's 4 px top pad plus half the 13 px title's 19 px line. */
export const LAMP_Y = 14
/** A section label's marker: 12 px top pad plus half an 11 px label's 16 px line. */
export const LABEL_Y = 20

/** Text steps: title 13 px semibold, line 2 12 px, meta and chips 11 px. */
export const TYPE = { title: 'body', line2: 'footnote', meta: 'caption' } as const

/** The chip: 18 px tall, 11 px text, 6 px side padding, radius 4, no border. */
export const CHIP = { height: 18, font: 11, padX: 6, radius: 4, alpha: 0.14 } as const

const toRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '').slice(0, 6)
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
const toHex = (rgb: readonly number[]) => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
const lum = ([r, g, b]: readonly number[]) => {
  const c = [r!, g!, b!].map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(toRgb(a)), lum(toRgb(b))]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((v, i) => v + (b[i]! - v) * t)

/** The hue at the chip's opacity, as an 8-digit hex fill. */
export const chipFill = (hue: string) => toHex(toRgb(hue)) + Math.round(CHIP.alpha * 255).toString(16).padStart(2, '0')

/** The chip's fill flattened over the pane, for the contrast check. */
export const chipGround = (hue: string) => toHex(mix(toRgb(TOKENS.raised), toRgb(hue), CHIP.alpha))

/** The hue lightened, in 5 % steps toward the primary text, until it reads 4.5:1 on its chip. */
export function chipInk(hue: string): string {
  const ground = chipGround(hue)
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const ink = toHex(mix(toRgb(hue), toRgb(TOKENS.primary), t))
    if (contrast(ink, ground) >= 4.5) return ink
  }
  return TOKENS.primary
}

/** The neutral hue for a folder chip, where the session has no group. */
export const NEUTRAL_HUE = TOKENS.muted

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Text width estimate at 11 px: the label is centred, so an error splits on both sides. */
export function textWidth(label: string, mono = false): number {
  if (mono) return label.length * CHIP.font * 0.6
  let w = 0
  for (const ch of label) {
    if (ch === ' ') w += 3.1
    else if (/[A-Z0-9#]/.test(ch)) w += 7.2
    else if (/[a-z]/.test(ch)) w += 6.0
    else w += 4.2
  }
  return w
}

export type Chip = { source: string; width: number; height: number }

/** One chip as an SVG in CSS pixels: the one chip style for groups, folders and branches. */
export function chipSvg(label: string, hue: string, mono = false): Chip {
  const width = Math.ceil(textWidth(label, mono) + CHIP.padX * 2)
  const font = mono ? "ui-monospace, 'SF Mono', Menlo, monospace" : "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CHIP.height}" viewBox="0 0 ${width} ${CHIP.height}">` +
    `<rect x="0" y="0" width="${width}" height="${CHIP.height}" rx="${CHIP.radius}" fill="${chipFill(hue)}"/>` +
    `<text x="${width / 2}" y="12.5" text-anchor="middle" font-family="${font}" font-size="${CHIP.font}" font-weight="500" fill="${chipInk(hue)}">${esc(label)}</text></svg>`
  return { source, width, height: CHIP.height }
}

/** A hairline or bar that stretches to its slot: wide markup, no aspect kept. */
export function stretchSvg(height: number, fill: string, percent = 100, track = ''): string {
  const p = Math.max(0, Math.min(100, percent))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" preserveAspectRatio="none">` +
    (track ? `<rect x="0" y="0" width="1000" height="${height}" fill="${track}"/>` : '') +
    `<rect x="0" y="0" width="${p * 10}" height="${height}" fill="${fill}"/></svg>`
}

/** What sits on the rail column of one line of the pane. */
export type RailMark =
  | { kind: 'row'; lamp: Lamp; colour: string; line: 'full' | 'end' | 'none' }
  | { kind: 'now' }
  | { kind: 'hour' }
  | { kind: 'gap' }
  | { kind: 'blank'; line: boolean }

/** The default rail drawing height; each line passes its own estimated height. */
export const RAIL_H = 32

/**
 * Line heights on the desktop's text steps, for the rail column's height: the
 * rail is drawn in flow at the line's estimated height (no absolute layer, no
 * stretched SVG), so a row always shows its rail and lamp.
 */
export const LINE_PX = { title: 20, line2: 17, meta: 16, chip: 18, fuel: 16, acts: 32 } as const

/** A row's height: 4 px pads, the title, and each part below it after a 4 px gap. */
export function rowHeight(parts: { line2: boolean; chips: boolean; fuel: boolean; acts: boolean }): number {
  let h = STEP_PX.xs + LINE_PX.title + STEP_PX.xs
  if (parts.line2) h += STEP_PX.xs + LINE_PX.line2
  if (parts.chips) h += STEP_PX.xs + LINE_PX.chip
  if (parts.fuel) h += STEP_PX.xs + LINE_PX.fuel
  if (parts.acts) h += STEP_PX.xs + LINE_PX.acts
  return h
}

/** A section label line: 12 px above, an 11 px label, 4 px below. */
export const LABEL_H = STEP_PX.md + LINE_PX.meta + STEP_PX.xs

/** A fixed-width bar: the track and the share filled, no stretching. */
export function barSvg(width: number, height: number, fill: string, percent = 100, track = ''): string {
  const w = Math.max(1, Math.round(width))
  const p = Math.max(0, Math.min(100, percent))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}">` +
    (track ? `<rect x="0" y="0" width="${w}" height="${height}" rx="${height / 2}" fill="${track}"/>` : '') +
    `<rect x="0" y="0" width="${Math.round((w * p) / 100)}" height="${height}" rx="${height / 2}" fill="${fill}"/></svg>`
}

/** The content column's width in px, from the pane's columns (a cell is about 7.2 px on desktop). */
export function contentPx(bodyColumns: number | undefined): number {
  const pane = Math.round((bodyColumns ?? 48) * 7.2)
  return Math.max(120, pane - 2 - STEP_PX.sm * 2 - RAIL_W - STEP_PX.sm)
}

function lamp(l: Lamp, colour: string): string {
  const at = `cx="${RAIL_X}" cy="${LAMP_Y}"`
  switch (l) {
    case 'blocked':
      return `<circle ${at} r="5" fill="${TOKENS.warning}" stroke="${TOKENS.raised}" stroke-width="2"/>`
    case 'review':
      return `<circle ${at} r="5" fill="${TOKENS.raised}" stroke="${TOKENS.patina}" stroke-width="2"/>`
    case 'done':
      return `<circle ${at} r="5" fill="${TOKENS.raised}" stroke="${TOKENS.muted}" stroke-width="2"/>`
    case 'running':
      return `<style>.p{animation:p 1.6s ease-in-out infinite}@keyframes p{0%,100%{opacity:0}50%{opacity:.6}}` +
        `@media (prefers-reduced-motion:reduce){.p{animation:none;opacity:.35}}</style>` +
        `<circle class="p" ${at} r="8" fill="none" stroke="${TOKENS.signal}" stroke-width="2"/>` +
        `<circle ${at} r="5" fill="${TOKENS.signal}" stroke="${colour}" stroke-width="2"/>`
    case 'live':
      return `<circle ${at} r="5" fill="${TOKENS.signal}" stroke="${colour}" stroke-width="2"/>`
    default:
      return `<circle ${at} r="5" fill="${TOKENS.raised}" stroke="${colour}" stroke-width="2"/>`
  }
}

/**
 * The rail's one ink: the subtle hairline flattened over the pane, opaque, so
 * the line reads as one colour over the pane and over the current row's fill.
 */
export const RAIL_INK = toHex(mix(toRgb(TOKENS.raised), toRgb(TOKENS.primary), parseInt(TOKENS.subtle.slice(7, 9), 16) / 255))

/** The rail head's height: the drawn top of a cell that holds its marker; the fill below runs to the line's real foot. */
export const RAIL_HEAD = { row: 24, label: 28 } as const

/** The 2 px line the rail fill Box paints below the head, stretched by the row's own height. */
export const RAIL_FILL = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><rect x="0" y="0" width="2" height="1" fill="${RAIL_INK}"/></svg>`

/** Whether the line runs on below the head to the cell's foot: every rail mark but the last row and the empty spacer. */
export function railRuns(mark: RailMark): boolean {
  if (mark.kind === 'row') return mark.line === 'full'
  if (mark.kind === 'blank') return mark.line
  return true
}

/** The head height for a mark, or the given height for a spacer. */
export const railHead = (mark: RailMark, spacer: number) =>
  mark.kind === 'blank' ? spacer : mark.kind === 'row' ? RAIL_HEAD.row : RAIL_HEAD.label

/**
 * The head of one rail cell: the line on x = 12 in the one rail ink, the lamp
 * centred on the title's first line, or a label marker. No letter box. The
 * row's colour tints only its lamp, never the line.
 */
export function railSvg(mark: RailMark, tall: number = RAIL_H): string {
  const line = (y1: number, y2: number) =>
    `<line x1="${RAIL_X}" y1="${y1}" x2="${RAIL_X}" y2="${y2}" stroke="${RAIL_INK}" stroke-width="2"/>`
  let body = ''
  if (mark.kind === 'row') {
    if (mark.line === 'full') body = line(0, tall)
    if (mark.line === 'end') body = line(0, LAMP_Y)
    body += lamp(mark.lamp, mark.colour)
  } else if (mark.kind === 'now') {
    body = line(LABEL_Y, tall) + `<circle cx="${RAIL_X}" cy="${LABEL_Y}" r="3" fill="${TOKENS.signal}"/>`
  } else if (mark.kind === 'hour') {
    body = line(0, tall) + `<circle cx="${RAIL_X}" cy="${LABEL_Y}" r="2.5" fill="${TOKENS.muted}"/>`
  } else if (mark.kind === 'gap') {
    const c = LABEL_Y
    body = line(0, tall) + `<rect x="${RAIL_X - 6}" y="${c - 6}" width="12" height="12" fill="${TOKENS.raised}"/>` +
      `<g stroke="${TOKENS.muted}" stroke-width="2" stroke-linecap="round">` +
      `<line x1="${RAIL_X - 4}" y1="${c - 1}" x2="${RAIL_X + 4}" y2="${c - 6}"/><line x1="${RAIL_X - 4}" y1="${c + 5}" x2="${RAIL_X + 4}" y2="${c}"/></g>`
  } else if (mark.line) {
    body = line(0, tall)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${RAIL_W}" height="${tall}" viewBox="0 0 ${RAIL_W} ${tall}">${body}</svg>`
}

/** The 1 px spacer that gives the rail column its width without a height. */
export const RAIL_SPACER = `<svg xmlns="http://www.w3.org/2000/svg" width="${RAIL_W}" height="1" viewBox="0 0 ${RAIL_W} 1"></svg>`
