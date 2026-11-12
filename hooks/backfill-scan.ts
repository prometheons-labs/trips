// The backfill's transcript reader, run as `python3 -I -c BACKFILL_PY <json>` by
// backfill.ts. It reads ~/.claude/projects/*/*.jsonl (read only, the home
// folder resolved at run time) and prints, per local day asked for, the turns
// of each session active that day: { "days": { "YYYY-MM-DD": [session...] } }.
// A session counts when the desktop app has a record of it, or when its
// transcript was started from an interactive terminal (entrypoint "cli"), so
// headless and SDK runs stay out, as they do in the Trips pane.
// The source holds no backslash, backtick or dollar-brace, so the template
// literal passes it to Python unchanged.
export const BACKFILL_PY = `# Trips backfill: the turns of each session per local day, as JSON.
import datetime, glob, json, os, sys, time

ROOT = os.path.expanduser('~/.claude/projects')
DESKTOP = os.path.expanduser('~/Library/Application Support/Claude/claude-code-sessions')
STAMP = b'"timestamp":"'
HEAD = 64 * 1024
TAIL = 64 * 1024
BISECT = 1 << 20
TURNS = 8
SESSIONS = 24
PROMPT = 160
REPLY = 240

def date_of(raw):
    # The UTC date of a line's own stamp. A stamp inside a message is escaped,
    # so it never matches.
    i = raw.find(STAMP)
    if i < 0:
        return ''
    return raw[i + 13:i + 23].decode('ascii', 'replace')

def seconds(raw_iso):
    try:
        return datetime.datetime.fromisoformat(str(raw_iso).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0

def text_of(msg):
    c = (msg or {}).get('content')
    if isinstance(c, str):
        return c
    out = []
    if isinstance(c, list):
        for part in c:
            if isinstance(part, dict) and part.get('type') == 'text':
                out.append(str(part.get('text') or ''))
    return ' '.join(out)

def fold(s, n):
    return ' '.join(str(s or '').split())[:n]

def stamp_after(f, pos):
    # The date of the first stamped line after byte pos, or '' at the end.
    f.seek(pos)
    if pos:
        f.readline()
    for _ in range(400):
        raw = f.readline()
        if not raw:
            return ''
        d = date_of(raw)
        if d:
            return d
    return ''

def start_of(f, size, lo):
    # Lines are appended in time order: bisect to about the first line on lo.
    a, b = 0, size
    while b - a > BISECT:
        m = (a + b) // 2
        d = stamp_after(f, m)
        if d and d < lo:
            a = m
        else:
            b = m
    return a

def desktop():
    found = {}
    for path in glob.glob(os.path.join(DESKTOP, '*', '*', 'local_*.json')):
        try:
            with open(path) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        cli = d.get('cliSessionId') or str(d.get('sessionId') or '').replace('local_', '')
        if cli:
            found[cli] = {'title': str(d.get('title') or ''), 'cwd': str(d.get('cwd') or '')}
    return found

def head_info(f):
    f.seek(0)
    blob = f.read(HEAD)
    entry, cwd, first = '', '', ''
    for raw in blob.splitlines():
        if not raw.startswith(b'{'):
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        cwd = cwd or str(rec.get('cwd') or '')
        if rec.get('type') == 'user' and not rec.get('isMeta'):
            entry = entry or str(rec.get('entrypoint') or '')
            t = text_of(rec.get('message')).strip()
            if t and not first and not t.startswith('<'):
                first = t
    return entry, cwd, first

def tail_title(f, size):
    f.seek(max(0, size - TAIL))
    title, ai = '', ''
    for raw in f.read().splitlines():
        if b'-title"' not in raw:
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if rec.get('type') == 'custom-title':
            title = str(rec.get('customTitle') or title)
        elif rec.get('type') == 'ai-title':
            ai = str(rec.get('aiTitle') or ai)
    return title or ai

def turns_of(f, size, lo, hi):
    # Each prompt opens a turn; the turn's time is its last message, its reply
    # the last text the agent wrote in it.
    f.seek(start_of(f, size, lo) if size > BISECT else 0)
    if f.tell():
        f.readline()
    turns = []
    for raw in f:
        if not raw.startswith(b'{'):
            continue
        d = date_of(raw)
        if not d or d < lo:
            continue
        if d > hi:
            break
        if b'"type":"user"' not in raw and b'"type":"assistant"' not in raw:
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if rec.get('isMeta') or rec.get('isSidechain') or rec.get('isCompactSummary'):
            continue
        at = seconds(rec.get('timestamp'))
        if not at:
            continue
        text = text_of(rec.get('message')).strip()
        if rec.get('type') == 'user':
            if not text or text.startswith('<'):
                if turns:
                    turns[-1]['at'] = max(turns[-1]['at'], at)
                continue
            turns.append({'at': at, 'prompt': fold(text, PROMPT), 'reply': ''})
        else:
            if not turns:
                turns.append({'at': at, 'prompt': '', 'reply': ''})
            turns[-1]['at'] = max(turns[-1]['at'], at)
            if text:
                turns[-1]['reply'] = fold(text, REPLY)
    return turns

def main():
    arg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    days = sorted(set(str(d) for d in arg.get('days') or []))
    if not days:
        json.dump({'days': {}, 'files': 0}, sys.stdout)
        return
    want = set(days)
    lo = (datetime.date.fromisoformat(days[0]) - datetime.timedelta(days=1)).isoformat()
    hi = (datetime.date.fromisoformat(days[-1]) + datetime.timedelta(days=1)).isoformat()
    since = time.mktime(time.strptime(days[0], '%Y-%m-%d'))
    desk = desktop()
    out = {d: [] for d in days}
    files = 0
    for path in glob.glob(os.path.join(ROOT, '*', '*.jsonl')):
        if 'observer-sessions' in path:
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_mtime < since:
            continue
        sid = os.path.basename(path)[:-6]
        rec = desk.get(sid)
        try:
            with open(path, 'rb') as f:
                entry, cwd, first = head_info(f)
                if not rec and entry != 'cli':
                    continue
                files += 1
                turns = turns_of(f, st.st_size, lo, hi)
                if not turns:
                    continue
                title = (rec or {}).get('title') or tail_title(f, st.st_size) or first[:80] or sid[:8]
        except OSError:
            continue
        cwd = (rec or {}).get('cwd') or cwd
        project = os.path.basename(cwd.rstrip('/')) if cwd else ''
        by_day = {}
        for t in turns:
            key = time.strftime('%Y-%m-%d', time.localtime(t['at']))
            if key in want:
                by_day.setdefault(key, []).append({'at': int(t['at'] * 1000), 'prompt': t['prompt'], 'reply': t['reply']})
        for key, ts in by_day.items():
            # The first 2 and the last turns of the day, TURNS in all.
            keep = ts if len(ts) <= TURNS else ts[:2] + ts[-(TURNS - 2):]
            out[key].append({'id': sid, 'title': fold(title, 100), 'project': project, 'turns': keep, 'count': len(ts)})
    for key in out:
        out[key].sort(key=lambda s: -s['count'])
        out[key] = sorted(out[key][:SESSIONS], key=lambda s: s['turns'][-1]['at'])
    json.dump({'days': out, 'files': files}, sys.stdout, ensure_ascii=False)

main()
`
