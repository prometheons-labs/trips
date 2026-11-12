import { expect, test } from 'claude-code/testing'

import { GROUPS, blocked, row } from './fixture'
import { ALL, colourOf, elsewhere, elsewhereLine, groupStats, inGroup, optionLabel, validFilter } from './groups'
import { HUES, hue } from './rail'
import { world } from './world'

test('groups keep sidebar order with trips and waiting counts, zero parts left out', async () => {
  const trips = [row('a', 1, { groupId: 'cg-quote' }), row('b', 2, { groupId: 'cg-quote' }), row('c', 3, { groupId: 'cg-dispatch' })]
  const waiting = [blocked('w', 60, 'x', { groupId: 'cg-quote' })]
  const stats = groupStats(GROUPS, trips, waiting)
  expect(stats.map(s => s.name)).toEqual(GROUPS.map(g => g.name))
  expect(stats.map(optionLabel).slice(0, 3)).toEqual(['LEDGERLOOP', 'QUOTEFORGE · 2 · 1 waiting', 'DISPATCH DESK · 1'])
})

test('state A: All shows every group and counts nothing elsewhere', async () => {
  const waiting = [blocked('w', 60, 'x', { groupId: 'cg-lantern' })]
  expect(elsewhere(waiting, ALL, GROUPS).count).toBe(0)
  expect(inGroup(row('x', 1, { groupId: 'cg-lantern' }), ALL)).toBe(true)
})

test('state B: the filter hides other groups but counts their waiting rows', async () => {
  const waiting = [
    blocked('w1', 60, 'x', { groupId: 'cg-lantern' }),
    blocked('w2', 70, 'y', { groupId: 'cg-quote' }),
    blocked('w3', 80, 'z', { groupId: 'cg-eval' }),
  ]
  expect(inGroup(waiting[0]!, 'cg-quote')).toBe(false)
  const e = elsewhere(waiting, 'cg-quote', GROUPS)
  expect(elsewhereLine(e)).toBe('2 more waiting in EVAL BENCH, LANTERN')
})

test('a stored filter for a group that is gone reads as All', async () => {
  expect(validFilter('cg-gone', GROUPS)).toBe(ALL)
  expect(validFilter(42, GROUPS)).toBe(ALL)
  expect(validFilter('cg-lantern', GROUPS)).toBe('cg-lantern')
})

test('the line colour follows the sidebar group, the folder without one', async () => {
  expect(colourOf(row('a', 1, { groupId: 'cg-quote' }), GROUPS)).toBe(HUES[1])
  expect(colourOf(row('b', 1, { groupId: 'cg-lantern' }), GROUPS)).toBe(HUES[0])
  expect(colourOf(row('c', 1, { project: 'ledgerloop-web' }), GROUPS)).toBe(hue('ledgerloop-web'))
})

const rows = () => [
  row('t1', 1, { groupId: 'cg-quote', title: 'Eval Bench scoring rubric' }),
  row('t2', 3, { groupId: 'cg-dispatch', title: 'QuoteForge pricing page' }),
  blocked('b1', 2 * 24 * 60, 'approve the pricing plan', { groupId: 'cg-quote', title: 'Dispatch Desk route planner' }),
  blocked('b2', 2 * 24 * 60 + 5, 'pick option A or B', { groupId: 'cg-lantern', title: 'Choose the LedgerLoop colour tokens' }),
  row('p1', 3 * 24 * 60, { groupId: 'cg-triage', title: 'Triage Agent inbox rules' }),
]

test('the pane: All, a Select in sidebar order, and a filter that keeps the waiting count', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me' })
  const ui = await w.mount('desktop')
  expect((await ui.find({ key: 'filter:all' }))?.text).toBe('All')
  expect((await ui.find({ key: 'chip:all-badge' }))?.children?.[0]).toMatchObject({ type: 'Svg', props: { alt: '2 waiting' } })
  const select = await ui.find({ key: 'group' })
  expect(select).toBeDefined()

  await ui.select({ key: 'group', value: 'cg-quote' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  expect(texts).toContain('Eval Bench scoring rubric')
  expect(texts).toContain('Dispatch Desk route planner')
  expect(texts).not.toContain('QuoteForge pricing page')
  expect(texts).not.toContain('Choose the LedgerLoop colour tokens')
  expect(texts).toContain('1 more waiting in LANTERN')

  // The choice is remembered in the store; Show all returns to All.
  expect(w.store.get('groupFilter')).toBe('cg-quote')
  await ui.press({ key: 'elsewhere' })
  expect(w.store.get('groupFilter')).toBe(ALL)
  const back = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  expect(back).toContain('QuoteForge pricing page')
  await ui.unmount()
})

test('state C: a quiet group says so in one line', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me' })
  const ui = await w.mount('desktop')
  await ui.select({ key: 'group', value: 'cg-triage' })
  expect(await ui.find({ type: 'Text', text: 'No trips in TRIAGE AGENT in the last 24 h.' })).toBeDefined()
  expect(w.store.get('groupFilter')).toBe('cg-triage')
  await ui.unmount()
})
