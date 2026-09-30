#!/usr/bin/env python3
"""Offline exit-rule replay for V5 PAPER trades. Read-only: never talks to the broker.

Rebuilds each filled contract's bid path from telemetry (fill -> actual exit) plus the
30 s post-exit evidence window, then re-runs alternative exit rules over those paths.

  python3 tools/replay.py              # validate + compare exit rules
  python3 tools/replay.py --rebuild    # re-extract paths from telemetry first (after new sessions)

Limits: prices stop ~30 s after each real exit; a rule still holding then is closed at the
last known bid and counted as "trunc". Exits are valued at the triggering bid (no slippage),
so compare rules against each other, not against real P&L.
"""
import argparse, collections, csv, glob, itertools, json, os, pickle, re, subprocess
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCOUNT = sorted(glob.glob(os.path.join(ROOT, 'state', 'paper-accounts', '*/')))[0]
CACHE = os.path.join(ROOT, 'state', 'replay')


def iso_ms(s):
    base, _, frac = s.rstrip('Z').partition('.')
    return int(datetime.fromisoformat(base + '+00:00').timestamp() * 1000) + int((frac + '000')[:3])


def grep(pattern, files):
    proc = subprocess.run(['grep', '-h', '-E', pattern, *files], capture_output=True, text=True, env={**os.environ, 'LC_ALL': 'C'})
    return proc.stdout.splitlines()


def rebuild():
    telemetry = sorted(glob.glob(os.path.join(ACCOUNT, 'telemetry', '*.jsonl')))
    fills, quotes, latches = {}, collections.defaultdict(dict), {}
    for line in grep('"event":"(position_fill|position_quote_accepted|sell_latch)"', telemetry):
        m = json.loads(line); f = m['fields']; t = f.get('tradeId')
        if m['event'] == 'position_fill':
            fills.setdefault(t, {'entry': round(f['entryPrice'] * 100), 'fill': f['fillTimestampMs'], 'symbol': f['symbol']})
        elif m['event'] == 'sell_latch':
            latches.setdefault(t, {'reason': f['reason'], 'bid': round(f['bid'] * 100)})
        elif f.get('bid') is not None and f.get('sourceTimestamp'):
            quotes[t][iso_ms(f['sourceTimestamp'])] = round(f['bid'] * 100)
    post = collections.defaultdict(dict)
    for line in grep('POST_EXIT_QUOTE', glob.glob(os.path.join(ACCOUNT, 'post-exit-evidence', '*.jsonl'))):
        f = json.loads(line)['fields']
        if f.get('usable') and f.get('bid') is not None:
            post[f['tradeId']][f['sourceTimestampMs']] = round(f['bid'] * 100)
    exits = {}
    for line in open(os.path.join(ACCOUNT, 'paper-ledger.log')):
        if ' EXIT ' in line:
            g = dict(re.findall(r'(\w+)=(\S+)', line))
            if 'tradeId' in g and 'price' in g:
                exits[g['tradeId']] = {'price': round(float(g['price']) * 100), 'date': g['date']}
    trades = []
    for t, info in fills.items():
        if t not in exits or t not in latches:
            continue
        q = quotes.get(t, {})
        last = max(q) if q else info['fill']
        path = sorted(q.items()) + sorted((k, v) for k, v in post.get(t, {}).items() if k > last)
        if len(path) < 3:
            continue
        compact = [path[0]]
        for ts, bid in path[1:]:
            if bid != compact[-1][1]:
                compact.append((ts, bid))
        trades.append(dict(id=t, date=exits[t]['date'], symbol=info['symbol'], entry=info['entry'], fill=info['fill'],
                           path=compact, exit_fill=exits[t]['price'], reason=latches[t]['reason'], latch_bid=latches[t]['bid']))
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, 'trades.pkl'), 'wb') as fh:
        pickle.dump(trades, fh)
    return trades


def simulate(t, grace_s, ref_mode, scheme, loss_pct=10, grace_stop_pct=None):
    """Return (exit_bid_cents, reason, truncated). Mirrors positions.mjs: the anchor is the bid
    current at fill+grace; loss floor sells at <=; profit floors sell strictly below."""
    entry, grace_end = t['entry'], t['fill'] + grace_s * 1000
    anchor = ref = floor = peak = loss_floor = last = None
    for ts, bid in t['path']:
        if anchor is None:
            if ts < grace_end:
                last = bid
                if ts >= t['fill'] and grace_stop_pct and bid <= entry * (1 - grace_stop_pct / 100):
                    return bid, 'grace_stop', False
                continue
            anchor = last if last is not None else bid
            ref = max(entry, anchor) if ref_mode == 'max' else anchor
            loss_floor = ref * (100 - loss_pct) / 100
            if anchor <= loss_floor:
                return anchor, 'loss', False
        if bid <= loss_floor and (floor is None or floor <= loss_floor):
            return bid, 'loss', False
        kind = scheme[0]
        if floor is not None and bid < floor:
            return bid, 'profit_floor', False
        if kind == 'CUR':  # +5 arm/floor, +8 re-arm/floor, fixed ceiling
            if bid >= ref + scheme[1]:
                return bid, 'ceiling', False
            new = ref + 8 if bid >= ref + 8 else ref + 5 if bid >= ref + 5 else None
        elif kind == 'LADDER':  # every +step reached raises the floor to (level - lock)
            step, lock = scheme[1], scheme[2]
            k = (bid - ref) // step
            new = ref + k * step - lock if k >= 1 else None
        else:  # TRAIL: once bid >= ref+arm, floor = highest bid - gap
            arm, gap = scheme[1], scheme[2]
            if bid >= ref + arm:
                peak = max(peak or bid, bid)
                new = peak - gap
            else:
                new = None
        if new is not None and (floor is None or new > floor):
            floor = new
    return t['path'][-1][1], 'truncated', True


SCHEMES = {
    'current: +5/+8 floors, +10 ceiling': ('CUR', 10),
    'current, ceiling +20': ('CUR', 20),
    'ladder step 5, lock 3': ('LADDER', 5, 3),
    'ladder step 5, lock 5': ('LADDER', 5, 5),
    'trail from +2, gap 4': ('TRAIL', 2, 4),
    'trail from +3, gap 4': ('TRAIL', 3, 4),
    'trail from +3, gap 5': ('TRAIL', 3, 5),
    'trail from +5, gap 3': ('TRAIL', 5, 3),
}


def score(trades, *args, **kw):
    by = collections.defaultdict(lambda: {'pnl': 0, 'wins': 0, 'n': 0, 'trunc': 0})
    for t in trades:
        px, _, trunc = simulate(t, *args, **kw)
        for key in (t['date'], 'ALL'):
            b = by[key]; b['pnl'] += px - t['entry']; b['wins'] += px > t['entry']; b['n'] += 1; b['trunc'] += trunc
    return by  # cents per share summed == USD per 1-lot contract


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rebuild', action='store_true')
    args = ap.parse_args()
    cache = os.path.join(CACHE, 'trades.pkl')
    trades = rebuild() if args.rebuild or not os.path.exists(cache) else pickle.load(open(cache, 'rb'))
    dates = sorted({t['date'] for t in trades})
    base = score(trades, 10, 'anchor', SCHEMES['current: +5/+8 floors, +10 ceiling'])
    same = sum(simulate(t, 10, 'anchor', SCHEMES['current: +5/+8 floors, +10 ceiling'])[0] == t['latch_bid'] for t in trades)
    print(f"{len(trades)} contracts over {', '.join(dates)}")
    print(f"validation: replay of current rule ${base['ALL']['pnl']} vs bot latch bids ${sum(t['latch_bid'] - t['entry'] for t in trades)}"
          f" vs actual fills ${sum(t['exit_fill'] - t['entry'] for t in trades)}; same exit bid on {same}/{len(trades)}\n")
    rows = []
    for grace, ref, name in itertools.product([0, 5, 10, 20], ['anchor', 'max'], SCHEMES):
        rows.append((grace, ref, name, score(trades, grace, ref, SCHEMES[name])))
    rows.sort(key=lambda r: -r[3]['ALL']['pnl'])
    print(f"{'grace':>5} {'ref':>6}  {'exit rule':36} {'total$':>7} {'win%':>5} " + ' '.join(f'{d[5:]:>7}' for d in dates) + f" {'trunc':>5}")
    for grace, ref, name, b in rows:
        a = b['ALL']
        print(f"{grace:>5} {ref:>6}  {name:36} {a['pnl']:>7} {100 * a['wins'] // a['n']:>4}% " + ' '.join(f"{b[d]['pnl']:>7}" for d in dates) + f" {a['trunc']:>5}")


if __name__ == '__main__':
    main()
