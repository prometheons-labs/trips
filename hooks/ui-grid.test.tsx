import { expect, test } from 'claude-code/testing'

import { GROUPS, blocked, row } from './fixture'
import { CHIP, LAMP_Y, STEP_PX, contrast, chipGround, chipInk } from './grid'
import { HUES, TOKENS } from './rail'
import { world } from './world'

type El = { type: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

const keyOf = (el: El) => (el.key ?? el.props?.key) as string | undefined
const kids = (el: El): El[] => (el.children ?? []).filter((c): c is El => !!c && typeof c === 'object' && 'type' in (c as object))
function walk(el: El, out: El[] = []): El[] {
  out.push(el)
  for (const c of kids(el)) walk(c, out)
  return out
}
const svgsIn = (el: El) => walk(el).filter(e => e.type === 'Svg').map(e => String(e.props?.source ?? ''))

const SPACING = ['gap', 'columnGap', 'rowGap', 'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']
const LEFT = ['padding', 'paddingX', 'paddingLeft', 'margin', 'marginX', 'marginLeft']

const rows = () => [
  row('me', 1, { groupId: 'cg-ledger', recap: 'Adding group tabs to the Trips wireframe.' }),
  row('v', 7, { groupId: 'cg-eval', status: 'review_ready', recap: 'The landing-page report is live.', branch: 'phase-4', prs: [{ prNumber: 1, url: 'https://github.com/x/y/pull/1', state: 'open' }] }),
  row('f', 30, { project: 'eval-bench', status: 'completed', recap: 'Saved.' }),
  blocked('b', 2 * 24 * 60, 'pick option A or B in the box below', { groupId: 'cg-lantern', title: 'Choose the LedgerLoop colour tokens' }),
  ...[1, 2, 3, 4, 5, 6].map(n => blocked(`b${n}`, n * 60, `ask ${n}`, { groupId: 'cg-quote' })),
  row('old', 3 * 24 * 60, { title: 'Parser 2.4 via Lantern' }),
]

test('the pane sits on the 4 px grid: chips, one content column, no letter box, Select beside All', { options: { actOnOtherSessions: true } }, async ($, on) => {
  const w = await world($, on, { rows: rows(), groups: GROUPS, sessionId: 'me', contextPercent: 46 })
  const ui = await w.mount('desktop')
  const tree = (await ui.drawn()) as unknown as El
  const all = walk(tree)

  // Every padding, margin and gap is 0 or a grid step, and every step is a multiple of 4 px.
  for (const el of all.filter(e => e.type === 'Box'))
    for (const p of SPACING) {
      const v = el.props?.[p]
      if (v === undefined || v === 0) continue
      expect(typeof v).toBe('string')
      expect(STEP_PX[v as keyof typeof STEP_PX] % 4).toBe(0)
    }

  // The chip: 18 px tall, radius 4, 11 px text, no border, the hue at a low alpha.
  const chips = all.filter(e => e.type === 'Box' && keyOf(e)?.startsWith('chip:') && kids(e)[0]?.type === 'Svg')
  expect(chips.length).toBeGreaterThanOrEqual(3)
  for (const c of chips) {
    const svg = kids(c)[0]!
    expect(svg.props?.height).toBe(CHIP.height)
    const src = String(svg.props?.source)
    expect(src).toContain(`height="${CHIP.height}"`)
    expect(src).toContain(`rx="${CHIP.radius}"`)
    expect(src).toContain(`font-size="${CHIP.font}"`)
    expect(src).not.toContain('stroke')
    expect(src).toMatch(/<rect [^>]*fill="#[0-9a-f]{6}24"/)
  }
  // Group, folder and branch chips all share that one style.
  expect(chips.map(c => keyOf(c))).toEqual(expect.arrayContaining(['chip:v:grp', 'chip:f:dir', 'chip:v:br']))

  // One content column: title, line 2, chips and fuel start at the same x.
  for (const id of ['me', 'v', 'b1']) {
    const col = all.find(e => keyOf(e) === `content:row:${id}`)
    expect(col).toBeDefined()
    const lane = all.find(e => keyOf(e) === `lane:row:${id}`)!
    expect(kids(lane).map(k => keyOf(k) ?? k.type)).toEqual([`rail:row:${id}`, `content:row:${id}`])
    const parts = kids(col!).map(k => keyOf(k))
    expect(parts[0]).toBe(`title:${id}`)
    expect(parts).toContain(`l2:${id}`)
    for (const k of kids(col!)) for (const p of LEFT) expect(k.props?.[p]).toBeUndefined()
  }
  const meParts = kids(all.find(e => keyOf(e) === 'content:row:me')!).map(k => keyOf(k))
  expect(meParts).toContain('fuel:me')
  expect(kids(all.find(e => keyOf(e) === 'content:row:v')!).map(k => keyOf(k))).toContain('chips:v')

  // No letter box: the rail drawings hold no text and no square marker; the lamp sits on the title line.
  const rails = all.filter(e => keyOf(e)?.startsWith('lane:row:')).map(l => String(kids(kids(l)[0]!)[0]?.props?.source ?? ''))
  expect(rails.length).toBeGreaterThanOrEqual(3)
  for (const src of rails) {
    expect(src).not.toContain('<text')
    expect(src).not.toContain('rx="2"')
    expect(src).toContain(`cy="${LAMP_Y}"`)
  }

  // The group bar: All on the left, the Select on the right, space-between.
  const bar = all.find(e => keyOf(e) === 'gbar')!
  expect(bar.props?.justifyContent).toBe('space-between')
  expect(kids(bar).map(k => keyOf(k))).toEqual(['gall', 'gsel'])
  expect(kids(kids(bar)[0]!).map(k => keyOf(k) ?? k.type)).toEqual(['filter:all', 'Text', 'chip:all-badge'])
  // The amber All badge: amber text on amber at about 14 %.
  const badge = String(kids(all.find(e => keyOf(e) === 'chip:all-badge')!)[0]!.props?.source)
  expect(badge).toContain(`fill="${TOKENS.warning}24"`)
  expect(badge).toContain('7 waiting')
  expect(walk(kids(bar)[1]!).some(e => e.type === 'Select' && keyOf(e) === 'group')).toBe(true)

  // Type scale: title 13 (body, semibold), line 2 12 (footnote), meta and chips 11 (caption).
  for (const t of all.filter(e => e.type === 'Text')) {
    expect(['body', 'footnote', 'caption']).toContain(t.props?.size)
    if (t.props?.size === 'body') expect(t.props?.weight).toBe('semibold')
  }
  // Line 2 truncates with an ellipsis inside the content column.
  const l2 = all.find(e => keyOf(e) === 'l2:v')!
  expect(walk(l2).find(e => e.type === 'Text')?.props?.wrap).toBe('truncate-end')

  // The fold row: amber text on the content column, and "show" is a real Button.
  const foldLane = all.find(e => keyOf(e) === 'lane:platform-more')!
  expect(kids(foldLane).map(k => keyOf(k))).toEqual(['rail:platform-more', 'content:platform-more'])
  const foldText = walk(all.find(e => keyOf(e) === 'foldtext:platform-more')!).find(e => e.type === 'Text')!
  expect(foldText.props?.color).toBe(TOKENS.warning)
  expect(all.find(e => e.type === 'Button' && keyOf(e) === 'flip:platform-more')?.props?.label).toBe('show')

  // Each row's rail: an in-flow Svg with words, the row's height, its line colour and its lamp.
  for (const [id, lampFill] of [['b1', TOKENS.warning], ['v', TOKENS.patina], ['f', TOKENS.muted]] as const) {
    const rail = kids(all.find(e => keyOf(e) === `rail:row:${id}`)!)[0]!
    expect(rail.type).toBe('Svg')
    expect(String(rail.props?.alt).length).toBeGreaterThan(0)
    const src = String(rail.props?.source)
    expect(src).toContain(`height="${rail.props?.height}"`)
    expect(src).toMatch(/<line [^>]*stroke="#[0-9a-f]{6}"/)
    expect(src).toContain(lampFill)
    expect(src).toContain(`cy="${LAMP_Y}"`)
  }
  expect(String(kids(all.find(e => keyOf(e) === 'rail:row:me')!)[0]!.props?.source)).toContain(HUES[0]!)
  // No element is laid absolute for the rail, and every Svg carries an alt.
  for (const el of all.filter(e => e.type === 'Svg')) expect(String(el.props?.alt ?? '').length).toBeGreaterThan(0)
  // "now" ends in a hairline.
  expect(walk(all.find(e => keyOf(e) === 'hairline')!).some(e => e.type === 'Svg' && e.props?.alt === 'divider')).toBe(true)

  // No Svg outside the chips draws text.
  const chipSources = new Set(chips.map(c => String(kids(c)[0]!.props?.source)))
  for (const src of svgsIn(tree)) if (!chipSources.has(src)) expect(src).not.toContain('<text')
  await ui.unmount()
})

test('chip ink reads 4.5:1 on its own fill for every hue', async () => {
  for (const hue of [...HUES, TOKENS.muted, TOKENS.patina]) expect(contrast(chipInk(hue), chipGround(hue))).toBeGreaterThanOrEqual(4.5)
})
