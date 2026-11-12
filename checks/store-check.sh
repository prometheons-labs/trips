#!/bin/bash
# Runs the real journal store (hooks/journal-store.ts) against a temporary HOME:
# the lease race, renew and release, a corrupt day moved aside, the path guard,
# the journalDir folder and the start mark.
# `claude plugin test` cannot spawn processes, so this checks the Python itself.
# Prints PASS and exits 0 only when every check holds. Never touches the real
# ~/.claude/trips-journal.
set -u
M=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
bun -e "import { JOURNAL_PY } from '$M/hooks/journal-store.ts'; await Bun.write('$T/store.py', JOURNAL_PY)" || { echo "FAIL: extract"; exit 1; }
export HOME="$T/home"
mkdir -p "$HOME"
J() { python3 -I -c "$(cat "$T/store.py")" "$@"; }
R="$HOME/.claude/trips-journal"
fail() { echo "FAIL: $*"; exit 1; }

# M2: an expired lease, 8 sessions race to take it over, 30 rounds: one wins each time.
for round in $(seq 1 30); do
  mkdir -p "$R"
  echo '{"holder": "old", "expiry": 0}' > "$R/lease.json"
  rm -f "$T"/out.*
  for n in 1 2 3 4 5 6 7 8; do
    J lease "{\"holder\": \"h$n\", \"now\": 1000, \"ttlMs\": 600000}" > "$T/out.$n" &
  done
  wait
  wins=$(grep -l '"held": true' "$T"/out.* | wc -l | tr -d ' ')
  [ "$wins" = 1 ] || fail "round $round: $wins holders"
  winner=$(grep -l '"held": true' "$T"/out.* | sed 's/.*out\.//')
  grep -q "\"holder\": \"h$winner\"" "$R/lease.json" || fail "round $round: lease file is not the winner's"
  [ -e "$R/lease.lock" ] && fail "round $round: lock left behind"
done
echo "ok lease race: 30 rounds, one holder each"

# M1: a live lease is never taken by another holder; only its holder renews or releases it.
rm -f "$R/lease.json"
J lease '{"holder": "a", "now": 1000, "ttlMs": 600000}' | grep -q '"held": true' || fail "a takes a free lease"
J lease '{"holder": "b", "now": 2000, "ttlMs": 600000}' | grep -q '"held": false' || fail "b takes a live lease"
J lease '{"holder": "a", "now": 3000, "ttlMs": 600000}' | grep -q '"held": true' || fail "a renews"
grep -q '"expiry": 603000' "$R/lease.json" || fail "renew moves the expiry"
J release '{"holder": "b"}' >/dev/null
[ -e "$R/lease.json" ] || fail "b released a's lease"
J release '{"holder": "a"}' >/dev/null
[ -e "$R/lease.json" ] && fail "a did not release"
echo "ok lease holders: no steal, renew, release by holder only"

# L5: a corrupt day is moved aside, not loaded and not overwritten.
mkdir -p "$R/days"
echo '{not json' > "$R/days/2026-11-11.json"
out=$(J state '{"now": 1763000000000}')
grep -q '"days": \[\]' <<<"$out" || fail "corrupt day still listed: $out"
ls "$R/days" | grep -q '^2026-11-11.corrupt-[0-9]*.json$' || fail "corrupt day not moved aside"
echo "ok corrupt day moved aside"

# Atomic write and the path guard.
J write '{"writes": [{"path": "days/2026-11-12", "data": {"date": "2026-11-12"}}]}' | grep -q written || fail "write"
ls "$R/days" | grep -q tmp && fail "tmp file left"
J write '{"writes": [{"path": "../evil", "data": {}}]}' >/dev/null 2>&1 && fail "path guard"
echo "ok write and path guard"

# The journalDir option: argv 3 points the store at another folder, ~ expanded.
O="$HOME/other-journal"
python3 -I -c "$(cat "$T/store.py")" write '{"writes": [{"path": "days/2026-11-13", "data": {"date": "2026-11-13"}}]}' "~/other-journal" | grep -q written || fail "write to journalDir"
[ -f "$O/days/2026-11-13.json" ] || fail "journalDir file missing"
[ -f "$R/days/2026-11-13.json" ] && fail "journalDir write reached the default folder"
python3 -I -c "$(cat "$T/store.py")" state '{}' "relative/dir" >/dev/null 2>&1 && fail "relative journalDir accepted"
echo "ok journalDir folder"

# The start mark: kept on a rerun, replaced only by an earlier start.
J mark '{"at": "t1", "mode": "fresh", "from": "2026-11-12"}' | grep -q '"written": true' || fail "first mark"
J mark '{"at": "t2", "mode": "fresh", "from": "2026-11-12"}' | grep -q '"written": false' || fail "mark rerun"
J mark '{"at": "t3", "mode": "7d", "from": "2026-11-05"}' | grep -q '"written": true' || fail "earlier mark"
grep -q '"from": "2026-11-05"' "$R/start.json" || fail "mark file"
echo "ok start mark"
echo PASS
