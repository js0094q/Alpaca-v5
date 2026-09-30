"""Sequenced replay (read-only): exit rules + pause-after-loss with censoring bounds.\nRun after `python3 tools/replay.py --rebuild`, from the repo root. Needs state/replay/{trades.pkl,buys.pkl,signals.jsonl}.\n"resolved" = exits seen inside recorded prices; unresolved contracts are reported under a stated\nscenario (one cent under the protected floor, or at the loss floor if never armed) and at the last bid.\nThe floor-minus-one value is a scenario estimate, not a guaranteed lower bound on fills."""
import pickle,json,collections
T=pickle.load(open('state/replay/trades.pkl','rb'))
def sim(t,rule,refmode='max'):
    e=t['entry']; g=t['fill']+10000; anchor=None; floor=peak=None
    for ts,bid in t['path']:
        if anchor is None:
            if ts<g: continue
            anchor=bid
            ref=max(e,anchor) if refmode=='max' else anchor; lf=ref*0.9
            if anchor<=lf: return anchor,ts,False,None
        if bid<=lf and (floor is None or floor<=lf): return bid,ts,False,None
        if rule=='cur':
            if bid>=ref+10: return bid,ts,False,None
            if floor is not None and bid<floor: return bid,ts,False,None
            nf=ref+8 if bid>=ref+8 else ref+5 if bid>=ref+5 else None
            if nf and (floor is None or nf>floor): floor=nf
        else:
            if floor is not None and bid<floor: return bid,ts,False,None
            if bid>=ref+2:
                peak=max(peak or bid,bid)
                if floor is None or peak-4>floor: floor=peak-4
    lb=t['path'][-1][1]
    worst=(floor-1) if (floor is not None and anchor is not None) else (int(lf) if anchor is not None else int(e*0.9))
    return lb,t['path'][-1][0],True,min(worst,lb)
t2s={}
for l in open('state/replay/signals.jsonl'):
    m=json.loads(l)
    if m['event']=='position_fill': t2s[m['fields']['tradeId']]=m['fields']['tradeSetId']
B=sorted(pickle.load(open('state/replay/buys.pkl','rb')),key=lambda b:b['t'])
bysets=collections.defaultdict(list)
for t in T: bysets[t2s.get(t['id'])].append(t)
def run(rule,pause,refmode='max',strict=False,label=''):
    res=collections.defaultdict(lambda:[0,0,0,0]); scenario_low=0 # resolved $, resolved contracts, unresolved contracts, buys
    busy=0; pd=None; mark=collections.Counter(); blocked_date=None
    for b in B:
        ts_=bysets.get(b['id'])
        if not ts_: continue
        if b['date']!=pd:
            busy=0; blocked_date=None; pd=b['date']
        # An unresolved simulated set may still own contracts beyond its final recorded
        # quote. With no later path to prove it became flat, do not admit later buys
        # that day. A new session date clears the simulation's ownership block.
        if blocked_date==b['date']: continue
        if b['t']<busy: continue
        outs=[sim(t,rule,refmode) for t in ts_]
        close=max(o[1] for o in outs); unk=any(o[2] for o in outs)
        pnl=sum(o[0]-t['entry'] for o,t in zip(outs,ts_))
        r=res[b['date']]; r[3]+=1
        for o,t in zip(outs,ts_):
            mark[b['date']]+=o[0]-t['entry']
            scenario_low+=(o[3] if o[2] else o[0])-t['entry']
            if o[2]: r[2]+=1
            else: r[0]+=o[0]-t['entry']; r[1]+=1
        lost=(pnl<0) if strict else (pnl<=0)
        if unk:
            blocked_date=b['date']
        else:
            busy=close+(pause*1000 if (pause and lost) else 5000)
    d1,d2='2026-09-28','2026-09-29'
    print(f"{label:34} buys {res[d1][3]+res[d2][3]:>3} | resolved ${res[d1][0]+res[d2][0]:>5} (9/28 {res[d1][0]:>4}, 9/29 {res[d2][0]:>5}) on {res[d1][1]+res[d2][1]:>3} contracts | unresolved {res[d1][2]+res[d2][2]:>3} contracts | total at last bid ${mark[d1]+mark[d2]:>5} | scenario total (unresolved one cent under floor) ${scenario_low:>5}")
print('Reference = max(entry, anchor) for every row. A buy is skipped if the bot would still be holding or pausing.')
print('Pause triggers on a counterfactual set result < $0 and starts when that set closes.')
run('cur',0,strict=True,label='baseline +5/+8/+10')
run('trail',0,strict=True,label='trail +2/-4')
run('cur',60,strict=True,label='baseline + 1-min pause')
run('trail',60,strict=True,label='trail + 1-min pause')
run('trail',300,strict=True,label='trail + 5-min pause')
