// The daily summary's store, run as `python3 -I -c JOURNAL_PY <op> <json> [root]`
// by journal.ts. Everything lives under the journal folder (the `journalDir`
// option, ~/.claude/trips-journal/ by default), the home folder resolved at run
// time. Writes go to a temporary file, then rename over the
// target. The lease is read, replaced or removed only under lease.lock, made
// with O_EXCL, so two sessions can never both hold it.
// The source holds no backslash, backtick or dollar-brace, so the template
// literal passes it to Python unchanged.
export const JOURNAL_PY = `# Trips daily summary store. Ops: state, read, write, lease, release, mark.
import json, os, re, sys, time

def root_of(raw):
    # The journal folder: argv 3, a leading ~ expanded, else the default.
    path = os.path.expanduser(str(raw or '').strip() or os.path.join('~', '.claude', 'trips-journal'))
    if not os.path.isabs(path):
        raise ValueError('journal folder must be absolute: ' + path)
    return os.path.normpath(path)

ROOT = root_of(sys.argv[3] if len(sys.argv) > 3 else '')
DIRS = ('days', 'weeks', 'months', 'years')
LEASE = os.path.join(ROOT, 'lease.json')
KEY = re.compile('[0-9]{4}(-[0-9]{2}(-[0-9]{2})?|-W[0-9]{2})?')

def path_of(rel):
    parts = str(rel).split('/')
    if len(parts) != 2 or parts[0] not in DIRS or not KEY.fullmatch(parts[1]):
        raise ValueError('bad path ' + str(rel))
    return os.path.join(ROOT, parts[0], parts[1] + '.json')

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None

def keys(d):
    try:
        names = os.listdir(os.path.join(ROOT, d))
    except OSError:
        return []
    return sorted(n[:-5] for n in names if n.endswith('.json') and KEY.fullmatch(n[:-5]))

def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp.' + str(os.getpid())
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def load_day(k):
    # A day file that does not parse is moved aside, never overwritten.
    path = path_of('days/' + k)
    try:
        with open(path) as f:
            return json.load(f)
    except OSError:
        return None
    except ValueError:
        try:
            os.replace(path, os.path.join(ROOT, 'days', k + '.corrupt-' + str(int(time.time())) + '.json'))
        except OSError:
            pass
        return None

def state(arg):
    now = float(arg.get('now') or time.time() * 1000) / 1000
    lists = {d: keys(d) for d in DIRS}
    recent = {}
    for k in lists['days'][-int(arg.get('recent') or 3):]:
        recent[k] = load_day(k)
    lists['days'] = keys('days')
    return {
        'root': ROOT,
        'tzOffsetMin': int(time.localtime(now).tm_gmtoff // 60),
        'lists': lists,
        'recent': recent,
    }

def read(arg):
    return {'files': {rel: load(path_of(rel)) for rel in arg.get('paths') or []}}

def write(arg):
    done = []
    for w in arg.get('writes') or []:
        write_atomic(path_of(w['path']), w['data'])
        done.append(w['path'])
    return {'written': done}

LOCK = os.path.join(ROOT, 'lease.lock')

def locked(fn):
    # Every look at the lease that may replace or remove it runs under lease.lock,
    # made with O_EXCL. A lock left by a crash is broken after 30 seconds.
    os.makedirs(ROOT, exist_ok=True)
    for _ in range(200):
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            try:
                if time.time() - os.stat(LOCK).st_mtime > 30:
                    os.remove(LOCK)
                    continue
            except OSError:
                continue
            time.sleep(0.01)
            continue
        try:
            os.close(fd)
            return fn()
        finally:
            try:
                os.remove(LOCK)
            except OSError:
                pass
    return None

def lease(arg):
    holder = str(arg.get('holder') or '')
    now = float(arg.get('now') or 0)
    ttl = float(arg.get('ttlMs') or 600000)
    if not holder:
        return {'held': False, 'holder': ''}

    def take():
        cur = load(LEASE)
        if cur is None and os.path.exists(LEASE):
            return {'held': False, 'holder': ''}
        # Free, expired, or this same instance renewing: replace it whole.
        if cur is None or cur.get('holder') == holder or float(cur.get('expiry') or 0) < now:
            tmp = LEASE + '.tmp.' + str(os.getpid())
            with open(tmp, 'w') as f:
                json.dump({'holder': holder, 'expiry': now + ttl}, f)
            os.replace(tmp, LEASE)
        mine = load(LEASE) or {}
        return {'held': mine.get('holder') == holder, 'holder': str(mine.get('holder') or '')}

    got = locked(take)
    return got if got is not None else {'held': False, 'holder': ''}

def release(arg):
    def drop():
        cur = load(LEASE) or {}
        if cur.get('holder') and cur.get('holder') == arg.get('holder'):
            try:
                os.remove(LEASE)
            except OSError:
                pass
        return {'released': True}
    return locked(drop) or {'released': False}

MARK = os.path.join(ROOT, 'start.json')

def mark(arg):
    # The journal's start marker, written by /trips setup. Kept when it exists,
    # unless the new one starts earlier (a longer backfill after a shorter one).
    cur = load(MARK)
    new = {'at': str(arg.get('at') or ''), 'mode': str(arg.get('mode') or ''), 'from': str(arg.get('from') or '')}
    if isinstance(cur, dict) and str(cur.get('from') or '') <= new['from']:
        return {'mark': cur, 'written': False}
    write_atomic(MARK, new)
    return {'mark': new, 'written': True}

OPS = {'state': state, 'read': read, 'write': write, 'lease': lease, 'release': release, 'mark': mark}
op = sys.argv[1] if len(sys.argv) > 1 else ''
arg = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
if op not in OPS:
    sys.stderr.write('unknown op ' + op)
    sys.exit(2)
json.dump(OPS[op](arg), sys.stdout, ensure_ascii=False)
`
