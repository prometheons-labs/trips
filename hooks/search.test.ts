import { expect, test } from 'claude-code/testing'

import { row } from './fixture'
import { matches, noMatchLine, searchParked } from './search'
import { world } from './world'

const DAY_MIN = 24 * 60

test('a query matches title, group, branch or folder, case folded, every word', async () => {
  const r = row('g', 3 * DAY_MIN, { title: 'Parser 2.4 via Lantern', groupId: 'cg-eval', branch: 'feat/lantern' })
  expect(matches(r, 'parser')).toBe(true)
  expect(matches(r, 'EVAL BENCH')).toBe(true)
  expect(matches(r, 'feat/lantern')).toBe(true)
  expect(matches(r, 'parser lantern')).toBe(true)
  expect(matches(r, 'parser zebra')).toBe(false)
  expect(matches(r, '   ')).toBe(true)
})

test('state A: an empty query keeps both sections folded', async () => {
  const p = searchParked([row('a', 2 * DAY_MIN)], [row('b', 9 * DAY_MIN)], '')
  expect([p.isSearching, p.total]).toEqual([false, 2])
})

test('state C: no match says so in one line', async () => {
  const p = searchParked([row('a', 2 * DAY_MIN)], [], 'zebra')
  expect([p.isSearching, p.total]).toEqual([true, 0])
  expect(noMatchLine(' zebra ')).toBe('No parked session matches "zebra".')
})

test('the pane: typing filters Sidings and Depot, grouped by folder', async ($, on) => {
  const rows = [
    row('now', 1, { title: 'Trips pane speed-up' }),
    row('s1', 3 * DAY_MIN, { title: 'Parser 2.4 via Lantern' }),
    row('s2', 4 * DAY_MIN, { title: 'Pricing survey' }),
    row('d1', 19 * DAY_MIN, { title: 'Lexer vs Parser trial' }),
  ]
  const w = await world($, on, { rows, sessionId: 'me' })
  const ui = await w.mount('desktop')
  expect(await ui.find({ type: 'Text', text: 'Parser 2.4 via Lantern' })).toBeUndefined()

  await ui.input({ key: 'search', text: 'parser', kind: 'change' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  expect(texts).toContain('Parser 2.4 via Lantern')
  expect(texts).toContain('Lexer vs Parser trial')
  expect(texts).toContain('tools · Sidings')
  expect(texts).toContain('tools · Depot')
  expect(texts).not.toContain('Pricing survey')

  await ui.input({ key: 'search', text: 'zebra', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'No parked session matches "zebra".' })).toBeDefined()
  await ui.unmount()
})

test('mobile draws no field, so no search box there', async ($, on) => {
  const w = await world($, on, { rows: [row('a', 1)], sessionId: 'me' })
  const ui = await w.mount('mobile')
  expect(await ui.find({ key: 'search' })).toBeUndefined()
  await ui.unmount()
})
