# SPDX-License-Identifier: MIT
"""Sequence alignment between the lyrics and what the recogniser heard.

Both sides are lists of comparison keys (toneless pinyin or lower-case words). The result tells
which lyric units were not sung, which heard units are not in the lyrics (ad-libs or a repeat the
lyrics leave out), and which lyric unit was heard as which recognised unit.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass

MATCH = 2
MISMATCH = -1
GAP = -1


@dataclass
class Pair:
    lyric: int | None  # index into the lyric keys, None for an extra heard unit
    heard: int | None  # index into the heard keys, None for an unsung lyric unit
    exact: bool = False  # the keys were equal (otherwise a recognition error or a homophone)


@dataclass
class Run:
    kind: str  # "not_sung" | "adlib" | "repeat_unwritten"
    heard: tuple[int, int] | None  # [start, end) in heard indexes
    lyric: tuple[int, int] | None  # [start, end) in lyric indexes
    repeat_of: tuple[int, int] | None = None  # lyric [start, end) the extra heard units repeat


def align_keys(lyric: list[str], heard: list[str]) -> list[Pair]:
    """Global alignment (Needleman-Wunsch) of two key sequences."""
    n, m = len(lyric), len(heard)
    if n == 0 or m == 0:
        return [Pair(i, None) for i in range(n)] + [Pair(None, j) for j in range(m)]
    prev = [j * GAP for j in range(m + 1)]
    trace = bytearray((n + 1) * (m + 1))  # 1 diagonal, 2 up (lyric only), 3 left (heard only)
    width = m + 1
    for j in range(1, m + 1):
        trace[j] = 3
    for i in range(1, n + 1):
        cur = [i * GAP] + [0] * m
        trace[i * width] = 2
        a = lyric[i - 1]
        for j in range(1, m + 1):
            diag = prev[j - 1] + (MATCH if a == heard[j - 1] else MISMATCH)
            up = prev[j] + GAP
            left = cur[j - 1] + GAP
            best = diag
            move = 1
            if up > best:
                best, move = up, 2
            if left > best:
                best, move = left, 3
            cur[j] = best
            trace[i * width + j] = move
        prev = cur
    out: list[Pair] = []
    i, j = n, m
    while i > 0 or j > 0:
        move = trace[i * width + j] if (i > 0 or j > 0) else 0
        if i > 0 and j > 0 and move == 1:
            out.append(Pair(i - 1, j - 1, lyric[i - 1] == heard[j - 1]))
            i, j = i - 1, j - 1
        elif i > 0 and (move == 2 or j == 0):
            out.append(Pair(i - 1, None))
            i -= 1
        else:
            out.append(Pair(None, j - 1))
            j -= 1
    out.reverse()
    return out


def _runs(pairs: list[Pair], pick: str) -> list[tuple[int, int, int, int]]:
    """Maximal runs of unmatched pairs of one side: (pair_start, pair_end, idx_start, idx_end)."""
    runs: list[tuple[int, int, int, int]] = []
    start = None
    for k, p in enumerate(pairs + [Pair(0, 0)]):
        unmatched = (p.heard is None) if pick == "lyric" else (p.lyric is None)
        if unmatched and start is None:
            start = k
        elif not unmatched and start is not None:
            idx = [(pairs[q].lyric if pick == "lyric" else pairs[q].heard) for q in range(start, k)]
            runs.append((start, k, int(idx[0]), int(idx[-1]) + 1))  # type: ignore[arg-type]
            start = None
    return runs


def find_runs(
    pairs: list[Pair],
    lyric: list[str],
    heard: list[str],
    line_of_lyric: list[int],
    repeat_ratio: float = 0.75,
) -> list[Run]:
    """Classify the unmatched stretches of an alignment.

    ``line_of_lyric[i]`` is the line of lyric unit ``i``; a stretch of extra heard units that
    reproduces an earlier lyric line (similarity >= ``repeat_ratio``) is a repeat the lyrics leave
    out, any other stretch is an ad-lib.
    """
    out: list[Run] = []
    for _, _, a, b in _runs(pairs, "lyric"):
        out.append(Run("not_sung", None, (a, b)))
    first_unit_of_line: dict[int, int] = {}
    last_unit_of_line: dict[int, int] = {}
    for idx, line in enumerate(line_of_lyric):
        first_unit_of_line.setdefault(line, idx)
        last_unit_of_line[line] = idx
    lines_sorted = sorted(first_unit_of_line)
    for ps, pe, a, b in _runs(pairs, "heard"):
        anchor = next((pairs[q].lyric for q in range(ps - 1, -1, -1) if pairs[q].lyric is not None), None)
        anchor_line = line_of_lyric[anchor] if anchor is not None else None
        heard_keys = heard[a:b]
        repeat: tuple[int, int] | None = None
        if len(heard_keys) >= 2:
            for line in lines_sorted:
                if anchor_line is not None and line > anchor_line:
                    break
                lo, hi = first_unit_of_line[line], last_unit_of_line[line] + 1
                ratio = difflib.SequenceMatcher(None, lyric[lo:hi], heard_keys, autojunk=False).ratio()
                if ratio >= repeat_ratio:
                    repeat = (lo, hi)
                    break
        out.append(Run("repeat_unwritten" if repeat else "adlib", (a, b), None, repeat))
    out.sort(key=lambda r: (r.lyric or r.heard or (0, 0))[0])
    return out
