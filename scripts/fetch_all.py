#!/usr/bin/env python3
"""Flight-radar data pipeline (runs in GitHub Actions every 5 min).

1. Fetch 3 regional ADS-B circles from adsb.lol, merge + dedupe -> flights.json
2. Maintain a watchlist of callsigns whose route touches Israel
   (via adsbdb, persisted in watchlist.json on the data branch).
3. Track every watchlisted callsign globally via adsb.lol -> global.json.
4. All three files are force-pushed as a single commit to the `data` branch.
"""
import json
import time
import urllib.parse
import urllib.request

REPO = 'ohrmich-png/flight-radar'
REGIONS = [(31.5, 34.9), (36.0, 29.0), (31.0, 41.0)]  # Israel, west Med, east
IL = {'TLV', 'ETM', 'HFA'}
DATA_RAW = f'https://raw.githubusercontent.com/{REPO}/data/watchlist.json'


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'flight-radar-bot/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def main():
    # 1. Regional feed
    seen, now = {}, 0
    for lat, lon in REGIONS:
        try:
            d = get(f'https://api.adsb.lol/v2/point/{lat}/{lon}/250')
        except Exception as e:
            print('region failed', lat, lon, e)
            continue
        now = max(now, d.get('now', 0))
        for a in d.get('ac', []):
            h = str(a.get('hex', '')).lower()
            if h and not h.startswith('~') and h not in seen:
                seen[h] = a
        time.sleep(2)
    regional = list(seen.values())
    regional_cs = set()
    for a in regional:
        cs = (a.get('flight') or '').strip()
        if cs:
            regional_cs.add(cs)

    # 2. Watchlist (persisted)
    try:
        wl = get(DATA_RAW, timeout=30)
    except Exception:
        wl = {}
    callsigns = wl.get('callsigns', {})   # cs -> {added, last_seen}
    not_il = wl.get('not_il', {})         # cs -> ts (checked, not Israel-related)
    ts = int(time.time())
    for cs in regional_cs:
        if cs in callsigns:
            callsigns[cs]['last_seen'] = ts

    # 3. Enrich new callsigns via adsbdb
    new_cs = [cs for cs in regional_cs if cs not in callsigns and cs not in not_il][:60]
    for cs in new_cs:
        try:
            d = get('https://api.adsbdb.com/v0/callsign/' + urllib.parse.quote(cs), timeout=30)
            fr = (d.get('response') or {}).get('flightroute') or {}
            o = ((fr.get('origin') or {}).get('iata_code') or '')
            dst = ((fr.get('destination') or {}).get('iata_code') or '')
            if o in IL or dst in IL:
                callsigns[cs] = {'added': ts, 'last_seen': ts}
            else:
                not_il[cs] = ts
        except Exception:
            pass
        time.sleep(0.3)

    # prune stale entries
    month_ago = ts - 30 * 86400
    not_il = {k: v for k, v in not_il.items() if v > month_ago}
    old = ts - 90 * 86400
    callsigns = {k: v for k, v in callsigns.items()
                 if v.get('last_seen', v.get('added', ts)) > old}

    # 4. Track watchlist globally (skip callsigns already seen regionally)
    have_hex = set(seen.keys())
    global_ac = []
    for cs in list(callsigns.keys()):
        if cs in regional_cs:
            continue
        try:
            d = get('https://api.adsb.lol/v2/callsign/' + urllib.parse.quote(cs), timeout=30)
            for a in d.get('ac', []):
                h = str(a.get('hex', '')).lower()
                if h and not h.startswith('~') and h not in have_hex \
                        and a.get('lat') is not None and a.get('lon') is not None:
                    global_ac.append(a)
                    have_hex.add(h)
        except Exception:
            pass
        time.sleep(0.15)

    json.dump({'now': now, 'ac': regional}, open('/tmp/flights.json', 'w'))
    json.dump({'now': int(time.time() * 1000), 'ac': global_ac}, open('/tmp/global.json', 'w'))
    json.dump({'updated': ts, 'callsigns': callsigns, 'not_il': not_il},
              open('/tmp/watchlist.json', 'w'))
    print(f'regional: {len(regional)}  global: {len(global_ac)}  '
          f'watchlist: {len(callsigns)}  not_il: {len(not_il)}')


if __name__ == '__main__':
    main()
