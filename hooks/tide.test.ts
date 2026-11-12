import { expect, test } from 'claude-code/testing'

import type { SessionRow } from '../types'
import { ageLabel, byFolder, tide } from './tide'

const NOW = 1_800_000_000_000
const H = 3600 * 1000
const row = (id: string, hoursAgo: number, extra: Partial<SessionRow> = {}): SessionRow => ({
  id, localId: `local_${id}`, title: id, project: 'tools', lastPrompt: '', mtimeMs: NOW - hoursAgo * H,
  clock: '10:00', hour: '10:00', isToday: true, daysAgo: Math.floor(hoursAgo / 24), weekday: 'Mon',
  parentLocalId: '', createdAtMs: 0, isArchived: false, isStarred: false,
  status: '', nextAction: '', summaryId: '', recap: '', groupId: '', groupName: '', branch: '', prs: [], worktreePath: '', ...extra,
})

test('tide puts 23 h on the rail, 25 h in the Sidings and 8 d in the Depot', async () => {
  const t = tide([row('d', 192), row('a', 23), row('r', 25)], NOW)
  expect([t.awake.map(r => r.id), t.resting.map(r => r.id), t.archive.map(r => r.id)]).toEqual([['a'], ['r'], ['d']])
})

test('an archived session goes to Archive whatever its age', async () => {
  expect(tide([row('x', 1, { isArchived: true })], NOW).archive.length).toBe(1)
})

test('a row without a desktop localId is left out', async () => {
  const t = tide([row('cli', 1, { localId: '' })], NOW)
  expect(t.awake.length + t.resting.length + t.archive.length).toBe(0)
})

test('archive ages read today, yesterday, N d', async () => {
  expect([0, 1, 4].map(d => ageLabel(row('x', d * 24)))).toEqual(['today', 'yesterday', '4 d'])
})

test('folders run by their newest session, rows newest first inside', async () => {
  const rows = [
    row('a1', 30, { project: 'alpha' }),
    row('b1', 26, { project: 'beta' }),
    row('a2', 28, { project: 'alpha' }),
    row('b2', 40, { project: 'beta' }),
  ]
  const groups = byFolder(rows, 30).map(g => `${g.project}:${g.rows.map(r => r.id).join(',')}`)
  expect(groups).toEqual(['beta:b1,b2', 'alpha:a2,a1'])
})

test('the cap keeps the newest rows overall before grouping', async () => {
  const rows = [row('a1', 30, { project: 'alpha' }), row('b1', 26, { project: 'beta' }), row('a2', 28, { project: 'alpha' })]
  expect(byFolder(rows, 2).flatMap(g => g.rows.map(r => r.id))).toEqual(['b1', 'a2'])
})
