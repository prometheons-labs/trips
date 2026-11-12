import { expect, test } from 'claude-code/testing'

import type { SessionRow } from '../types'
import { railSvg } from './grid'
import { TOKENS, hue, layout } from './rail'

const NOW = 1_800_000_000_000
const row = (id: string, minsAgo: number, hour: string): SessionRow => ({
  id, localId: `local_${id}`, title: `Session ${id}`, project: 'tools', lastPrompt: 'hi',
  mtimeMs: NOW - minsAgo * 60000, clock: hour.replace(':00', ':15'), hour, isToday: true,
  daysAgo: 0, weekday: 'Sun', parentLocalId: '', createdAtMs: 0, isArchived: false, isStarred: false,
  status: '', nextAction: '', summaryId: '', recap: '', groupId: '', groupName: '', branch: '', prs: [], worktreePath: '',
})

test('newest first with hour labels and a gap break', async () => {
  const rows = [row('a', 0.5, '14:00'), row('b', 20, '14:00'), row('c', 70, '13:00'), row('d', 400, '07:00')]
  const kinds = layout(rows, NOW).map(i => (i.kind === 'row' ? i.row.id : `${i.kind}:${i.label}`))
  expect(kinds).toEqual(['a', 'b', 'hour:13:00', 'c', 'gap:6 h', 'hour:07:00', 'd'])
})

test('only sessions inside two minutes are live', async () => {
  const live = layout([row('a', 1, '14:00'), row('b', 3, '14:00')], NOW).flatMap(i => (i.kind === 'row' ? [i.isLive] : []))
  expect(live).toEqual([true, false])
})

test('the rail column draws a line and a lamp, never a letter box', async () => {
  const svg = railSvg({ kind: 'row', lamp: 'none', colour: hue('tools'), line: 'full' })
  expect(svg).toContain(`stroke="${hue('tools')}"`)
  expect(svg).not.toContain('<text')
  expect(railSvg({ kind: 'row', lamp: 'live', colour: hue('tools'), line: 'end' })).toContain(TOKENS.signal)
})
