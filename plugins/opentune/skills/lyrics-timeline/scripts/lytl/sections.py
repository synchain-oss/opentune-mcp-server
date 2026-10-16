# SPDX-License-Identifier: MIT
"""Section labels for lines: the user's tags first, otherwise repeated-block inference."""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from typing import Any, Sequence

SIMILAR = 0.8  # key-sequence similarity that makes two lines "the same line"


@dataclass
class LineInfo:
    keys: list[str]  # comparison keys of the line's units
    label: str | None = None  # user's canonical label
    label_number: int | None = None
    block: int = 0  # user's tag block or paragraph
    # Optional acoustic hints for the inference (None when unknown).
    start: float | None = None
    end: float | None = None
    gap_before: float | None = None
    level_db: float | None = None
    f0: float | None = None


@dataclass
class SectionPlan:
    label: str
    occurrence: int
    lines: list[int]
    source: str  # "user" or "inferred"
    conf: float
    notes: list[str] = field(default_factory=list)


def _similar(a: list[str], b: list[str]) -> bool:
    if not a or not b:
        return False
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() >= SIMILAR


def user_sections(lines: Sequence[LineInfo]) -> list[SectionPlan]:
    """One section per user tag block; occurrence counts blocks with the same label."""
    plans: list[SectionPlan] = []
    count: dict[str, int] = {}
    last_block = None
    for i, ln in enumerate(lines):
        label = ln.label or "unlabeled"
        if last_block is None or ln.block != last_block:
            count[label] = count.get(label, 0) + 1
            occurrence = count[label]
            if ln.label_number is not None:
                occurrence = ln.label_number
                count[label] = max(count[label], occurrence)
            plans.append(SectionPlan(label, occurrence, [], "user", 1.0))
            last_block = ln.block
        plans[-1].lines.append(i)
    return plans


def _repeated_blocks(lines: Sequence[LineInfo]) -> list[tuple[int, list[int]]]:
    """Families of repeated blocks: (block length, start line of each occurrence)."""
    n = len(lines)
    sim = [[False] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            sim[i][j] = _similar(lines[i].keys, lines[j].keys)
    taken = [False] * n
    families: list[tuple[int, list[int]]] = []
    # Longest runs first so that a two-line chorus is not split into two one-line families.
    for length in range(min(8, n // 2), 0, -1):
        for i in range(n - length + 1):
            if any(taken[i : i + length]):
                continue
            starts = [i]
            for j in range(i + length, n - length + 1):
                if any(taken[j : j + length]) or any(abs(j - s) < length for s in starts):
                    continue
                if all(sim[i + k][j + k] for k in range(length)):
                    starts.append(j)
            if len(starts) >= 2:
                for s in starts:
                    for k in range(length):
                        taken[s + k] = True
                families.append((length, starts))
    return families


def _score(family: tuple[int, list[int]], lines: Sequence[LineInfo]) -> float:
    length, starts = family
    score = float(len(starts) * length)
    n = len(lines)
    score += 0.5 * sum(1 for s in starts if s >= n / 2) / len(starts)
    gaps = [lines[s].gap_before for s in starts if lines[s].gap_before is not None]
    if gaps and sum(1 for g in gaps if g and g > 1.0) * 2 >= len(gaps):
        score += 0.5
    levels = [lines[s + k].level_db for s in starts for k in range(length) if lines[s + k].level_db is not None]
    if levels:
        overall = [ln.level_db for ln in lines if ln.level_db is not None]
        if overall and sum(levels) / len(levels) > sum(overall) / len(overall) + 1.0:
            score += 0.5
    pitches = [lines[s + k].f0 for s in starts for k in range(length) if lines[s + k].f0]
    if pitches:
        overall_f = [ln.f0 for ln in lines if ln.f0]
        if overall_f and sum(pitches) / len(pitches) > sum(overall_f) / len(overall_f) * 1.03:
            score += 0.5
    return score


def infer_sections(lines: Sequence[LineInfo]) -> list[SectionPlan]:
    """Label lines without user tags. The chorus is the best-scoring repeated block."""
    n = len(lines)
    families = [f for f in _repeated_blocks(lines) if f[0] >= 2 and len(f[1]) >= 2]
    if not families:  # fall back to a single repeated line, which needs three occurrences
        families = [f for f in _repeated_blocks(lines) if f[0] == 1 and len(f[1]) >= 3]
    owner = [-1] * n  # which family a line belongs to
    for fi, (length, starts) in enumerate(families):
        for s in starts:
            for k in range(length):
                owner[s + k] = fi
    chorus = max(range(len(families)), key=lambda f: _score(families[f], lines)) if families else None
    plans: list[SectionPlan] = []
    counts: dict[str, int] = {}

    def add(label: str, idxs: list[int], conf: float) -> None:
        counts[label] = counts.get(label, 0) + 1
        plans.append(SectionPlan(label, counts[label], idxs, "inferred", conf))

    # Cut the song into runs: consecutive lines of the chorus family occurrence, other families
    # (verse-like repeats are still "verse"), and plain lines. Paragraph breaks split plain runs.
    i = 0
    runs: list[tuple[str, list[int]]] = []
    while i < n:
        if chorus is not None and owner[i] == chorus:
            length = families[chorus][0]
            runs.append(("chorus", list(range(i, i + length))))
            i += length
            continue
        j = i
        while j < n and not (chorus is not None and owner[j] == chorus) and (j == i or lines[j].block == lines[i].block):
            j += 1
        runs.append(("other", list(range(i, j))))
        i = j
    chorus_runs = [k for k, (lab, _) in enumerate(runs) if lab == "chorus"]
    first_chorus = chorus_runs[0] if chorus_runs else None
    last_chorus = chorus_runs[-1] if chorus_runs else None
    for k, (lab, idxs) in enumerate(runs):
        if lab == "chorus":
            add("chorus", idxs, 0.8)
        elif first_chorus is None:
            add("verse", idxs, 0.4)
        elif k < first_chorus:
            if k == first_chorus - 1 and k > 0 and len(idxs) <= 3:
                add("pre-chorus", idxs, 0.5)
            else:
                add("verse", idxs, 0.6)
        elif last_chorus is not None and k > last_chorus:
            add("outro", idxs, 0.5)
        elif len(chorus_runs) >= 3 and k > chorus_runs[1] and k < last_chorus and sum(
            1 for r in range(chorus_runs[1] + 1, last_chorus) if runs[r][0] == "other"
        ) == 1:
            add("bridge", idxs, 0.5)
        else:
            add("verse", idxs, 0.6)
    return plans


def plan_sections(lines: Sequence[LineInfo]) -> list[SectionPlan]:
    if any(ln.label for ln in lines):
        return user_sections(lines)
    return infer_sections(lines)


def describe(plan: SectionPlan) -> dict[str, Any]:
    return {"label": plan.label, "occurrence": plan.occurrence, "source": plan.source, "conf": plan.conf}
