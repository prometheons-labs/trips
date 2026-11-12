import { expect, test } from 'claude-code/testing'

import { blocked, row } from './fixture'
import { ARCHIVE, EYE, UNDO_MS, UNPARK } from './register'
import { world } from './world'

type El = { type: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }
const keyOf = (el: El) => (el.key ?? el.props?.key) as string | undefined
const kids = (el: El): El[] => (el.children ?? []).filter((c): c is El => !!c && typeof c === 'object' && 'type' in (c as object))
function walk(el: El, out: El[] = []): El[] {
  out.push(el)
  for (const c of kids(el)) walk(c, out)
  return out
}
// The chain from the root to the element keyed `key`.
function pathTo(el: El, key: string, trail: El[] = []): El[] | undefined {
  const here = [...trail, el]
  if (keyOf(el) === key) return here
  for (const c of kids(el)) {
    const hit = pathTo(c, key, here)
    if (hit) return hit
  }
  return undefined
}

const rows = () => [
  row('me', 1),
  row('a', 10, { title: 'Pricing survey', status: 'review_ready' }),
  blocked('b', 60, 'pick A or B', { title: 'Choose the LedgerLoop colour tokens' }),
  blocked('c', 90, 'approve the plan', { title: 'Dispatch Desk route planner' }),
]
const tools = (w: { mcp: Array<{ tool: string; args: Record<string, unknown> }> }) =>
  w.mcp.filter(c => c.tool !== 'list_sessions').map(c => [c.tool, c.args.session_id])
const texts = async (ui: { findAll: (q: object) => Promise<Array<{ text: string }>> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

test('the eye and the archive icon show only on hover, inside the keyed row; none archive on the current row', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: {} })
  const ui = await w.mount('desktop')
  const tree = (await ui.drawn()) as unknown as El
  for (const id of ['a', 'b']) {
    const chain = pathTo(tree, `archive:${id}`)!
    const holder = chain[chain.length - 2]!
    expect(holder.props?.display).toBe('none')
    expect((holder as unknown as { hover?: { display?: string } }).hover?.display ?? (holder.props?.hover as { display?: string })?.display).toBe('flex')
    // The nearest keyed Box above it scopes the hover: the row's title line, drawn visible, inside the row's lane.
    const keyed = [...chain.slice(0, -2)].reverse().find(e => e.type === 'Box' && keyOf(e))!
    expect(keyOf(keyed)).toBe(`title:${id}`)
    expect(chain.some(e => keyOf(e) === `lane:row:${id}`)).toBe(true)
    expect(keyed.props?.display).toBeUndefined()
    expect(walk(holder).map(e => keyOf(e))).toEqual(expect.arrayContaining([`go:${id}`, `archive:${id}`]))
  }
  expect((await ui.find({ key: 'go:a' }))?.props?.label).toBe(EYE)
  expect((await ui.find({ key: 'archive:a' }))?.props?.label).toBe(ARCHIVE)
  expect(await ui.find({ key: 'archive:me' })).toBeUndefined()
  expect(await ui.find({ key: 'go:me' })).toBeUndefined()
  await ui.unmount()
})

const hostCalls = (w: { mcp: Array<{ tool: string }> }) => w.mcp.filter(c => c.tool !== 'list_sessions').map(c => c.tool)

test('park: no host call; the row leaves, its Undo row shows, and every waiting count drops by 1', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: {}, firstOpenUnplaced: true })
  const ui = await w.mount('desktop')
  const band = await w.mountBand('desktop')
  expect(await texts(ui)).toContain('2 of 4 blocked')
  expect((await band.find({ key: 'trips-count' }))?.text).toBe('\u23F3 2')

  await ui.press({ key: 'archive:b' })
  expect(hostCalls(w)).toEqual([])
  expect(w.store.get('parked')).toEqual({ local_b: { at: expect.any(Number), summaryId: 'sum-b' } })
  const after = await texts(ui)
  expect(after).toContain('Parked Choose the LedgerLoop colour tokens in the Depot ·')
  expect(after).not.toContain('pick A or B')
  expect(after).toContain('1 of 3 blocked')
  expect(await ui.find({ key: 'chip:all-badge' })).toMatchObject({ children: [{ props: { alt: '1 waiting' } }] })
  expect(w.titles[w.titles.length - 1]).toBe('Trips · 1 waiting')
  expect((await band.find({ key: 'trips-count' }))?.text).toBe('\u23F3 1')

  // Undo clears the mark and the row is back.
  await ui.press({ key: 'undo:b' })
  expect(w.store.get('parked')).toEqual({})
  expect(await texts(ui)).toContain('pick A or B')
  expect(await texts(ui)).toContain('2 of 4 blocked')
  expect(hostCalls(w)).toEqual([])
  await ui.unmount()
  await band.unmount()
})

test('after the Undo window it sits in the Depot with a parked tag, stays parked on rescans, and unpark brings it back', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: {} })
  const ui = await w.mount('desktop')
  await ui.press({ key: 'archive:b' })
  await w.clock.advance(UNDO_MS)
  await w.tick()
  await w.tick()
  let now = await texts(ui)
  expect(now).not.toContain('Parked Choose the LedgerLoop colour tokens in the Depot ·')
  expect(now).toContain('1 of 3 blocked')
  expect(now).toContain('over 7 days · 1')
  expect(w.toasts.filter(t => t.includes('waiting on you'))).toEqual([])

  // In the Depot: the parked tag, and Depot search finds it.
  await ui.input({ key: 'search', text: 'colour', kind: 'change' })
  expect(await ui.find({ key: 'chip:b:parked' })).toBeDefined()
  expect((await ui.find({ key: 'unpark:b' }))?.props?.label).toBe(UNPARK)
  await ui.press({ key: 'unpark:b' })
  await ui.input({ key: 'search', text: '', kind: 'change' })
  now = await texts(ui)
  expect(now).toContain('2 of 4 blocked')
  expect(w.store.get('parked')).toEqual({})
  expect(hostCalls(w)).toEqual([])
  await ui.unmount()
})

test('a worktree row parks at once: nothing is deleted, so no confirm', async ($, on) => {
  const tree = row('t', 5, { title: 'Lantern map slice', worktreePath: '/x/.claude/worktrees/busy' })
  const w = await world($, on, { rows: [row('me', 1), tree], sessionId: 'me', running: {} })
  const ui = await w.mount('desktop')
  await ui.press({ key: 'archive:t' })
  expect(await ui.find({ type: 'Text', text: 'Parked Lantern map slice in the Depot ·' })).toBeDefined()
  expect(hostCalls(w)).toEqual([])
  await ui.unmount()
})

test('the session asks again after the park: a new summary or new activity unparks it', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: {} })
  const ui = await w.mount('desktop')
  await ui.press({ key: 'archive:b' })
  await ui.press({ key: 'archive:c' })
  await w.clock.advance(UNDO_MS)
  await w.tick()
  expect(await texts(ui)).not.toContain('pick A or B')
  // b writes a new summary; c has a message after the mark.
  const later = w.clock.now() + 1000
  w.setRows([
    row('me', 1),
    row('a', 10, { title: 'Pricing survey', status: 'review_ready' }),
    blocked('b', 60, 'pick A or B, again', { title: 'Choose the LedgerLoop colour tokens', summaryId: 'sum-b2' }),
    blocked('c', 0, 'approve the plan', { title: 'Dispatch Desk route planner', mtimeMs: later }),
  ])
  await w.clock.advance(2000)
  await w.tick()
  const now = await texts(ui)
  expect(now).toContain('pick A or B, again')
  expect(now).toContain('approve the plan')
  expect(w.store.get('parked')).toEqual({})
  await ui.unmount()
})
