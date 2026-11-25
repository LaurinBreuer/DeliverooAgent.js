# Summarises bench.csv: mean ± std of the team score and switches/agent/min, per label and config.
# usage: python3 challenge1/test/summary.py challenge1/test/results/bench.csv [label ...]
import csv, statistics as st, sys
from collections import defaultdict

rows = defaultdict(list)
for r in csv.reader(open(sys.argv[1])):
    label, game, n, _rep, team, sw = r[:6]
    if team != "NA":
        rows[(game, n)].append((label, float(team), float(sw)))
labels = sys.argv[2:] or list(dict.fromkeys(l for v in rows.values() for l, _, _ in v))

def fmt(xs):
    return f"{st.mean(xs):6.0f} ±{(st.stdev(xs) if len(xs) > 1 else 0):4.0f}"

print("config".ljust(24), *[f"{l} score".rjust(13) + f" {l} sw/min".rjust(12) for l in labels])
for (game, n), v in rows.items():
    cells = []
    for l in labels:
        s = [t for ll, t, _ in v if ll == l]
        w = [x for ll, _, x in v if ll == l]
        cells.append((fmt(s) if s else "-".rjust(12)) + " " + (f"{st.mean(w):10.1f}" if w else "-".rjust(10)))
    print(f"{game} x{n}".ljust(24), *cells)
