import { expect, test } from 'claude-code/testing'

import { GROUPS, row } from './fixture'
import { LABEL_H, LAMP_Y, RAIL_INK, RAIL_X, rowHeight } from './grid'
import { TOKENS } from './rail'
import { world } from './world'

type El = { type: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

const keyOf = (el: El) => (el.key ?? el.props?.key) as string | undefined
const kids = (el: El): El[] => (el.children ?? []).filter((c): c is El => !!c && typeof c === 'object' && 'type' in (c as object))
function walk(el: El, out: El[] = []): El[] {
  out.push(el)
  for (const c of kids(el)) walk(c, out)
  return out
}

const GAPPY = ['margin', 'marginY', 'marginTop', 'marginBottom', 'padding', 'paddingY', 'paddingTop', 'paddingBottom']
const LONG = 'Make the Trips pane rail one connected line that matches the original design, with long titles that wrap'

// now, an hour, the selected trip, trips with long titles, a second hour, a quiet gap, the last trip.
const rows = () => [
  row('me', 1, { groupId: 'cg-ledger', title: LONG, hour: '12:00', recap: 'Fixing the rail so it runs through every row.' }),
  row('a', 20, { groupId: 'cg-eval', title: `${LONG} again`, hour: '12:00', status: 'review_ready', recap: 'A recap long enough to wrap onto a second line.' }),
  row('b', 80, { groupId: 'cg-lantern', title: LONG, hour: '11:00', branch: 'phase-4' }),
  row('c', 8 * 60, { title: 'After the quiet', hour: '04:00' }),
  row('d', 9 * 60, { title: 'The last trip', hour: '03:00', status: 'completed' }),
]

test('the rail is one connected line: every cell stretches to its row, no gap at any edge, one ink', async ($, on) => {
  const w = await world($, on, { rows: rows(), groups: GROUPS, sessionId: 'me', contextPercent: 46 })
  const ui = await w.mount('desktop')
  const all = walk((await ui.drawn()) as unknown as El)

  const lanes = all.filter(e => e.type === 'Box' && /^lane:(now|h\d+|g\d+|row:)/.test(keyOf(e) ?? ''))
  const names = lanes.map(l => keyOf(l)!)
  expect(names[0]).toBe('lane:now')
  expect(names.some(n => n.startsWith('lane:h'))).toBe(true)
  expect(names.some(n => n.startsWith('lane:g'))).toBe(true)
  expect(names.filter(n => n.startsWith('lane:row:'))).toEqual(['lane:row:me', 'lane:row:a', 'lane:row:b', 'lane:row:c', 'lane:row:d'])

  for (const lane of lanes) {
    const key = keyOf(lane)!.slice('lane:'.length)
    // The lane stretches its rail cell to the row's real height and pads only its content column.
    expect(lane.props?.flexDirection).toBe('row')
    expect(['stretch', undefined]).toContain(lane.props?.alignItems)
    for (const p of GAPPY) expect(lane.props?.[p]).toBeUndefined()
    const [rail, content] = kids(lane)
    expect(keyOf(rail!)).toBe(`rail:${key}`)
    expect(keyOf(content!)).toBe(`content:${key}`)
    // The rail cell: no fixed height, no self alignment that would shrink it, no vertical margin or padding.
    expect(rail!.props?.height).toBeUndefined()
    expect(['auto', undefined]).toContain(rail!.props?.alignSelf)
    expect(rail!.props?.flexDirection).toBe('column')
    for (const p of GAPPY) expect(rail!.props?.[p]).toBeUndefined()

    // The head starts at the cell's top edge and is never taller than the shortest row it heads.
    const head = kids(rail!)[0]!
    expect(head.type).toBe('Svg')
    const tall = Number(head.props?.height)
    expect(tall).toBeLessThanOrEqual(key.startsWith('row:') ? rowHeight({ line2: false, chips: false, fuel: false, acts: false }) : LABEL_H)
    const src = String(head.props?.source)
    // Every rail line is drawn in the one rail ink, the selected trip's too.
    const railLines = [...src.matchAll(/<line x1="(\d+)" y1="([\d.]+)" x2="(\d+)" y2="([\d.]+)" stroke="([^"]+)"/g)].filter(m => m[1] === `${RAIL_X}` && m[3] === `${RAIL_X}`)
    for (const m of railLines) expect(m[5]).toBe(RAIL_INK)

    const fill = kids(rail!).find(k => keyOf(k) === `railfill:${key}`)
    if (key === 'row:d') {
      // The last trip ends the rail at its lamp: no fill below it.
      expect(fill).toBeUndefined()
      expect(railLines.map(m => [m[2], m[4]])).toEqual([['0', `${LAMP_Y}`]])
      continue
    }
    // Every other cell draws its line to the head's foot and the fill runs on to the cell's foot.
    expect(railLines.some(m => Number(m[4]) === tall)).toBe(true)
    if (key !== 'now') expect(railLines.some(m => m[2] === '0')).toBe(true)
    expect(fill).toBeDefined()
    expect(fill!.props?.flexGrow).toBe(1)
    expect(fill!.props?.backgroundColor).toBe(RAIL_INK)
    for (const p of GAPPY) expect(fill!.props?.[p]).toBeUndefined()
    expect(String(kids(fill!)[0]?.props?.alt ?? '').length).toBeGreaterThan(0)
  }

  // The selected trip keeps its row fill, but its line is the same ink as every other cell.
  const me = lanes.find(l => keyOf(l) === 'lane:row:me')!
  expect(me.props?.backgroundColor).toBe(TOKENS.overlay)
  expect(kids(kids(me)[0]!).find(k => keyOf(k) === 'railfill:row:me')?.props?.backgroundColor).toBe(RAIL_INK)
  await ui.unmount()
})

test('a quiet gap draws its break mark with the line above and below it', async ($, on) => {
  const w = await world($, on, { rows: rows(), groups: GROUPS, sessionId: 'me' })
  const ui = await w.mount('desktop')
  const all = walk((await ui.drawn()) as unknown as El)
  const gap = all.find(e => e.type === 'Box' && /^rail:g\d+$/.test(keyOf(e) ?? ''))!
  expect(gap).toBeDefined()
  const head = kids(gap)[0]!
  const src = String(head.props?.source)
  // One line from the cell's top edge to the head's foot runs behind the break mark.
  expect(src).toContain(`<line x1="${RAIL_X}" y1="0" x2="${RAIL_X}" y2="${head.props?.height}" stroke="${RAIL_INK}"`)
  expect(src).toContain(`fill="${TOKENS.raised}"`)
  expect(src).toContain('stroke-linecap="round"')
  // Below the mark the fill carries the line on to the next cell.
  const fill = kids(gap).find(k => keyOf(k)?.startsWith('railfill:'))
  expect(fill?.props?.flexGrow).toBe(1)
  expect(fill?.props?.backgroundColor).toBe(RAIL_INK)
  await ui.unmount()
})
