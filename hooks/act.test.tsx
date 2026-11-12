import { expect, test } from 'claude-code/testing'

import { NOW, blocked, row } from './fixture'
import { NOT_RUNNING_LINE } from './platform'
import { world } from './world'

const ask = 'pick option A or B in the box below'
const rows = () => [row('me', 1), blocked('b', 2 * 24 * 60, ask, { title: 'Choose the LedgerLoop colour tokens' })]
const ON = { options: { actOnOtherSessions: true } }

test('state A: with the switch off (default) a blocked row has no Reply or Done', async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: { local_b: false, local_me: true } })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await w.mount(surface)
    expect(await ui.find({ key: 'reply-open:b' })).toBeUndefined()
    expect(await ui.find({ key: 'done:b' })).toBeUndefined()
    await ui.unmount()
  }
  expect(w.mcp.filter(c => c.tool === 'send_message' || c.tool === 'mark_completed')).toEqual([])
})

test('H1: the host answers b idle: b waits, Reply and Done show', ON, async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: { local_b: false, local_me: true } })
  const ui = await w.mount('desktop')
  expect(await ui.find({ type: 'Text', text: '1 of 2 blocked' })).toBeDefined()
  expect(await ui.find({ key: 'reply-open:b' })).toBeDefined()
  expect(await ui.find({ key: 'done:b' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: NOT_RUNNING_LINE })).toBeUndefined()
  await ui.unmount()
})

test('H1: the host answers b running: b stays on the Platform with Reply', ON, async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: { local_b: true, local_me: true } })
  const ui = await w.mount('desktop')
  expect(await ui.find({ type: 'Text', text: '1 of 2 blocked' })).toBeDefined()
  expect(await ui.find({ key: 'reply-open:b' })).toBeDefined()
  await ui.unmount()
})

test('state C: Reply opens a field, Return sends through the host, the toast says the delivery word', ON, async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', running: { local_b: false }, sendWord: 'queued' })
  const ui = await w.mount('desktop')
  // Never on the current session's own row.
  expect(await ui.find({ key: 'reply-open:me' })).toBeUndefined()
  await ui.press({ key: 'reply-open:b' })
  await ui.input({ key: 'reply:b', text: 'A, warm' })
  expect(w.mcp.filter(c => c.tool === 'send_message')).toEqual([
    { server: 'ccd_session_mgmt', tool: 'send_message', args: { session_id: 'local_b', message: 'A, warm' } },
  ])
  expect(w.sent).toEqual([])
  expect(w.toasts).toContain('Reply queued: Choose the LedgerLoop colour tokens')
  expect(await ui.find({ key: 'reply:b' })).toBeUndefined()
  await ui.unmount()
})

test('a host refusal falls back to session.send, delivered', ON, async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', sendMessageFails: true })
  const ui = await w.mount('desktop')
  await ui.press({ key: 'reply-open:b' })
  await ui.input({ key: 'reply:b', text: 'B' })
  expect(w.sent).toEqual([{ to: expect.anything(), text: 'B' }])
  expect(w.toasts).toContain('Reply delivered: Choose the LedgerLoop colour tokens')
  await ui.unmount()
})

test('state D: only when both routes fail does the row say it cannot take a reply', ON, async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', sendMessageFails: true, sessionSendFails: true })
  const ui = await w.mount('desktop')
  await ui.press({ key: 'reply-open:b' })
  await ui.input({ key: 'reply:b', text: 'B' })
  expect(await ui.find({ type: 'Text', text: NOT_RUNNING_LINE })).toBeDefined()
  expect(await ui.find({ key: 'act-open:b' })).toBeDefined()
  expect(await ui.find({ key: 'reply-open:b' })).toBeUndefined()
  await ui.unmount()
})

test('Done marks the session completed, takes it off the Platform and retitles at once', ON, async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me' })
  const ui = await w.mount('desktop')
  expect(w.titles[w.titles.length - 1]).toBe('Trips · 1 waiting')
  await ui.press({ key: 'done:b' })
  expect(w.mcp.filter(c => c.tool === 'mark_completed')).toEqual([{ server: 'ccd_sidebar', tool: 'mark_completed', args: { session_id: 'local_b' } }])
  expect(await ui.find({ type: 'Text', text: '1 of 2 blocked' })).toBeUndefined()
  expect(w.store.get('dismissed')).toEqual(['b:sum-b'])
  expect(w.titles[w.titles.length - 1]).toBe('Trips')
  expect(w.toasts).toContain('Choose the LedgerLoop colour tokens marked done')
  await ui.unmount()
})

test('L1: Done says so when the host refuses', ON, async ($, on) => {
  const w = await world($, on, { rows: rows(), sessionId: 'me', markFails: true })
  const ui = await w.mount('desktop')
  await ui.press({ key: 'done:b' })
  expect(w.toasts.some(t => t.includes('sidebar mark was not cleared'))).toBe(true)
  await ui.unmount()
})

test('M2: list_sessions covers every shown row, and an unlisted row is unknown, not idle', async ($, on) => {
  const many = Array.from({ length: 80 }, (_, n) => row(`r${n}`, n + 5))
  const w = await world($, on, { rows: [...many, row('me', 1)], sessionId: 'me', running: { local_me: true } })
  const call = w.mcp.find(c => c.tool === 'list_sessions')
  expect((call?.args.limit as number) >= 81).toBe(true)
  const ui = await w.mount('desktop')
  // r0 is 5 minutes old and unlisted: no "running", no fake idle, its time stands.
  expect(await ui.find({ type: 'Text', text: 'running' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: 'running' })).length).toBe(1)
  await ui.unmount()
})

test('M1: a row stored by 0.4.2 draws while the scan fails', async ($, on) => {
  const old = {
    id: 'x', localId: 'local_x', title: 'Old trip', project: 'tools', lastPrompt: 'hi', mtimeMs: NOW - 60000, clock: '10:00',
    hour: '10:00', isToday: true, daysAgo: 0, weekday: 'Sat', parentLocalId: '', createdAtMs: 0, isArchived: false, isStarred: false,
  }
  const w = await world($, on, { rows: [], sessionId: 'me', scanFails: true, store: { lastScan: { rows: [old], nowMs: NOW } } })
  const ui = await w.mount('desktop')
  expect(await ui.find({ type: 'Text', text: 'Old trip' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'You: hi' })).toBeDefined()
  await ui.unmount()
})
