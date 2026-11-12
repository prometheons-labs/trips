import { expect, test } from 'claude-code/testing'

import { blocked, row } from './fixture'
import { flips, paneTitle, toastText } from './nudge'
import { world } from './world'

const ask = 'approve the pricing plan'

test('a flip from review_ready to blocked toasts once', async () => {
  const prev = [row('a', 10, { status: 'review_ready' })]
  const next = [blocked('a', 0, ask)]
  const first = flips(prev, next, [], 'me')
  expect(first.toast.map(r => r.id)).toEqual(['a'])
  // The same scan again: already announced, no second toast.
  expect(flips(next, next, first.announced, 'me').toast).toEqual([])
  expect(flips(prev, next, first.announced, 'me').toast).toEqual([])
})

test('no toast for the current session, a flip to review_ready, or the first look', async () => {
  expect(flips([row('me', 5)], [blocked('me', 0, ask)], [], 'me').toast).toEqual([])
  expect(flips([row('a', 5)], [row('a', 0, { status: 'review_ready' })], [], 'me').toast).toEqual([])
  expect(flips([], [blocked('a', 0, ask)], [], 'me').toast).toEqual([])
})

test('a blocked session that asks again with a new summary is a new flip', async () => {
  const before = blocked('a', 30, 'first ask', { summaryId: 's1' })
  const after = blocked('a', 0, 'second ask', { summaryId: 's2' })
  expect(flips([before], [after], [], 'me').toast.map(r => r.nextAction)).toEqual(['second ask'])
})

test('the pane title counts the waiting rows', async () => {
  expect(paneTitle(3)).toBe('Trips · 3 waiting')
  expect(paneTitle(0)).toBe('Trips')
  expect(toastText(blocked('a', 0, ask, { title: 'Dispatch Desk route planner' }))).toBe(`Dispatch Desk route planner is waiting on you: ${ask}`)
})

test('between scans: one toast per flip, zero on the rerun, the title retitled', async ($, on) => {
  const w = await world($, on, { rows: [row('a', 10, { status: 'review_ready', title: 'Dispatch Desk route planner' }), row('me', 1)], sessionId: 'me' })
  expect(w.toasts).toEqual([])
  expect(w.titles[w.titles.length - 1]).toBe('Trips')

  w.setRows([blocked('a', 0, ask, { title: 'Dispatch Desk route planner' }), row('me', 1)])
  await w.tick()
  expect(w.toasts).toEqual([`Dispatch Desk route planner is waiting on you: ${ask}`])
  expect(w.titles[w.titles.length - 1]).toBe('Trips · 1 waiting')

  await w.tick()
  await w.tick()
  expect(w.toasts.length).toBe(1)
  expect(w.store.get('announced')).toEqual(['a:sum-a'])
})

test('the current session flipping to blocked makes no toast', async ($, on) => {
  const w = await world($, on, { rows: [row('me', 1, { status: 'review_ready' })], sessionId: 'me' })
  w.setRows([blocked('me', 0, ask)])
  await w.tick()
  expect(w.toasts).toEqual([])
})

test('L3: announcing merges into the keys another session already stored', async ($, on) => {
  const w = await world($, on, {
    rows: [row('a', 10, { status: 'review_ready', title: 'Dispatch Desk route planner' })],
    sessionId: 'me',
    store: { announced: ['other:s9'] },
  })
  w.setRows([blocked('a', 0, ask, { title: 'Dispatch Desk route planner' })])
  await w.tick()
  expect(w.store.get('announced')).toEqual(['other:s9', 'a:sum-a'])
})
