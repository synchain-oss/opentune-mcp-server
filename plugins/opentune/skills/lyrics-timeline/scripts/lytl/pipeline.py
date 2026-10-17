# SPDX-License-Identifier: MIT
"""The timeline pipeline: VAD, recognition, lyric comparison, alignment, snapping, sections.

One audio file is one track. A track may sing only part of the lyrics (one of several lead
singers, a harmony that sings only the chorus), so every lyric line is first checked against what
the recogniser heard on that track: a line with too little evidence is reported as not in the
track instead of being spread into a gap and force-aligned there.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import median
from typing import Any, Sequence

import numpy as np

from . import SCHEMA_VERSION, __version__
from .audio import (
    MAX_ALIGN_SEC,
    MAX_ASR_SEC,
    TARGET_SR,
    Features,
    detect_breaths,
    detect_onsets,
    energy_vad,
    frame_features,
    group_windows,
    split_chunks,
    voiced_ratio,
    voiced_start,
)
from .backends import AlignerBackend, AsrBackend
from .japanese import have_readings
from .langs import asr_language_for, decide_language, line_language
from .lyrics import LyricLine, parse_lyrics
from .normalize import Unit, homophone_alternatives, is_filler, match_sequence, units_text
from .seqalign import Pair, align_keys, find_runs, project_pairs
from .sections import LineInfo, plan_sections
from .snap import DEFAULT_SNAP_WINDOW, Note, enforce_order, snap_start, split_by_notes

WINDOW_PAD = 0.25
LONG_NOTE_SPLIT_MIN = 0.3  # only tokens at least this long get notes[] sub-segments
# When the aligner returned a different number of spans than we gave it units, its spans were
# resampled onto the units. Every token of such a line gets conf of at most this value, which is
# below the 0.5 at which SKILL.md tells the model to ask the user first.
APPROX_CONF_CAP = 0.4

# --- Is a lyric line sung on this track? -------------------------------------------------------
# Counted on comparison keys (a character, a mora, a word) that the recogniser heard exactly. Only
# exact keys count: the global alignment also pairs stray sounds (humming, a filler, a misheard
# word) with lines that are not on the track, because a mismatch costs less than two gaps, so a
# line covered only by such pairs is not evidence. Half of the keys is a compromise between the
# 0.6B recogniser's errors on singing (homophones and readings compare equal, so most errors still
# count) and chance matches of common sounds in a line that belongs to another track.
PRESENT_MIN_SHARE = 0.5
PRESENT_MIN_KEYS = 2  # and at least this many (all of them for a shorter line)
# A line that the lyrics mark for another singer, on a track whose label appears among the marks.
OTHER_SINGER_MIN_SHARE = 0.75
OTHER_SINGER_MIN_KEYS = 3
# Matches of one line more than this far apart (end of one heard unit to the start of the next)
# are separate stretches; only the stretch with the most exact keys counts.
CLUSTER_GAP_SEC = 3.0
# A single line without enough evidence between two lines that are on the track is still timed
# when the gap between them holds singing that nothing else explains: at least this much voice per
# unit of the line (and GAP_FILL_MIN_VOICE_SEC overall), measured GAP_MARGIN_SEC inside the gap.
GAP_FILL_VOICE_PER_UNIT = 0.15
GAP_FILL_MIN_VOICE_SEC = 0.5
GAP_MARGIN_SEC = 0.3
GAP_FILL_CONF_CAP = 0.45  # below the 0.5 at which the model asks the user
# Heard units that match no lyric line: stretches closer than this are one stretch; a stretch of
# at least UNMATCHED_MIN_UNITS units that is not only fillers goes to unmatched[], shorter ones
# stay ad-libs.
UNMATCHED_JOIN_SEC = 1.0
UNMATCHED_MIN_UNITS = 3


@dataclass
class Heard:
    unit: Unit
    start: float
    end: float
    mismatch: tuple[int, int] | None = None  # (spans returned, units given) when the aligner had to be resampled


@dataclass
class LineSpec:
    """A lyric line as parsed, shared by all tracks."""

    text: str
    units: list[Unit]
    seq: list[tuple[str, tuple[int, ...]]]  # comparison keys and the (line-local) units owning each
    lyric: LyricLine | None = None

    @property
    def keys(self) -> list[str]:
        return [k for k, _ in self.seq]


@dataclass
class _Line:
    """A line under construction for one track."""

    text: str
    units: list[Unit]
    lyric: LyricLine | None = None
    keys: list[str] = field(default_factory=list)
    window: tuple[float, float] | None = None
    sung: bool = True
    spans: list[tuple[float, float]] | None = None
    agree: list[float] | None = None
    kept: list[int] | None = None  # indexes into units that were aligned (others are not sung)
    mismatch: tuple[int, int] | None = None  # (spans returned, units given) when the aligner had to be resampled
    absent_reason: str | None = None
    gap_filled: bool = False


@dataclass
class TrackInput:
    """One audio file: 16 kHz mono samples and how to describe it."""

    x: np.ndarray
    audio_name: str = ""
    sample_rate: int = TARGET_SR
    label: str | None = None
    notes: Sequence[Note] = ()
    notes_requested: bool = False


@dataclass
class _Track:
    inp: TrackInput
    feats: Features
    duration: float
    regions: list[tuple[float, float]]
    chunks: list[tuple[float, float]]
    texts: list[str] = field(default_factory=list)
    reported: list[tuple[str | None, int]] = field(default_factory=list)
    heard: list[Heard] = field(default_factory=list)
    heard_seq: list[tuple[str, tuple[int, ...]]] = field(default_factory=list)
    match: _Match | None = None


@dataclass
class _Lyrics:
    """All lyric lines flattened: unit and key indexes across the whole song."""

    specs: list[LineSpec]
    line_of_unit: list[int]
    first_unit: list[int]
    keys: list[str]
    key_owners: list[tuple[int, ...]]  # global unit indexes
    key_line: list[int]
    families: list[list[int]]  # lines with the same keys (a repeated chorus line), size >= 2


@dataclass
class _Decision:
    present: bool = False
    cluster: set[int] = field(default_factory=set)  # heard units that count for the line
    kept: dict[int, float] = field(default_factory=dict)  # local unit index -> agreement
    extent: tuple[float, float] | None = None
    exact_keys: int = 0
    total_keys: int = 0
    other_singer: bool = False
    for_this: bool | None = None  # marked for this track (None: no usable mark)


@dataclass
class _Match:
    pairs: list[Pair]  # unit pairs after the decisions (pairs of lines not on the track split up)
    decisions: list[_Decision]


def _slice(x: np.ndarray, a: float, b: float) -> np.ndarray:
    return x[max(int(a * TARGET_SR), 0) : max(int(b * TARGET_SR), 0)]


def _r(v: float) -> float:
    return round(float(v), 3)


# --- Stages ------------------------------------------------------------------------------------


def _analyse(inp: TrackInput) -> _Track:
    feats = frame_features(inp.x)
    regions = energy_vad(feats)
    return _Track(inp, feats, inp.x.size / TARGET_SR, regions, split_chunks(regions, feats, MAX_ASR_SEC))


def _transcribe(tr: _Track, asr: AsrBackend, asr_language: str) -> None:
    for a, b in tr.chunks:
        text = asr.transcribe(_slice(tr.inp.x, a, b), a, b, asr_language)
        tr.texts.append(text)
        tr.reported.append((getattr(asr, "last_language", None), len(text.strip())))


def _time_heard(tr: _Track, aligner: AlignerBackend, lang: str) -> None:
    """Time the recognised units window by window, and build their comparison sequence."""
    chunk = [match_sequence(t, lang) for t in tr.texts]
    for group in group_windows(list(tr.chunks), MAX_ALIGN_SEC):
        units = [u for c in group for u in chunk[c][0]]
        if not units:
            continue
        ws, we = tr.chunks[group[0]][0], tr.chunks[group[-1]][1]
        spans = list(aligner.align(_slice(tr.inp.x, ws, we), ws, we, units, lang))
        mismatch = getattr(aligner, "last_mismatch", None)
        while len(spans) < len(units):  # never expected; keeps the indexes in step if it happens
            spans.append(spans[-1] if spans else (ws, we))
        base = len(tr.heard)
        for c in group:
            for key, owners in chunk[c][1]:
                tr.heard_seq.append((key, tuple(base + o for o in owners)))
            base += len(chunk[c][0])
        for u, (a, b) in zip(units, spans):
            tr.heard.append(Heard(u, float(a), float(b), mismatch))


def _prepare_lyrics(lyrics: str, lang: str, warnings: list[str]) -> _Lyrics:
    parsed = parse_lyrics(lyrics)
    warnings.extend(parsed.warnings)
    specs: list[LineSpec] = []
    for ll in parsed.lines:
        units, seq = match_sequence(ll.text, lang)
        if units:
            specs.append(LineSpec(ll.text, units, seq, ll))
    line_of_unit: list[int] = []
    first_unit: list[int] = []
    keys: list[str] = []
    key_owners: list[tuple[int, ...]] = []
    key_line: list[int] = []
    for li, sp in enumerate(specs):
        first_unit.append(len(line_of_unit))
        for key, owners in sp.seq:
            keys.append(key)
            key_owners.append(tuple(first_unit[li] + o for o in owners))
            key_line.append(li)
        line_of_unit.extend([li] * len(sp.units))
    by_keys: dict[tuple[str, ...], list[int]] = {}
    for li, sp in enumerate(specs):
        by_keys.setdefault(tuple(sp.keys), []).append(li)
    families = [f for f in by_keys.values() if len(f) >= 2]
    return _Lyrics(specs, line_of_unit, first_unit, keys, key_owners, key_line, families)


# --- Matching lyrics against one track ---------------------------------------------------------


def _singer_marks(lyr: _Lyrics, label: str | None) -> tuple[bool, str]:
    """(the track's label appears in the lyrics' singer marks, the folded label)."""
    if not label:
        return False, ""
    folded = label.casefold()
    for sp in lyr.specs:
        if sp.lyric and any(n.casefold() == folded for n in sp.lyric.singers if n != "all"):
            return True, folded
    return False, folded


def _decide(
    lyr: _Lyrics,
    tr: _Track,
    key_pairs: list[Pair],
    unit_pairs: list[Pair],
    label: str | None,
) -> list[_Decision]:
    marks_active, folded = _singer_marks(lyr, label)
    heard = tr.heard
    paired: dict[int, list[tuple[int, int, bool]]] = {}  # line -> (lyric unit, heard unit, exact)
    for p in unit_pairs:
        if p.lyric is not None and p.heard is not None:
            paired.setdefault(lyr.line_of_unit[p.lyric], []).append((p.lyric, p.heard, p.exact))
    exact_keys: dict[int, list[int]] = {}  # line -> heard units of its exactly heard keys (one per key)
    for p in key_pairs:
        if p.lyric is not None and p.heard is not None and p.exact:
            exact_keys.setdefault(lyr.key_line[p.lyric], []).append(tr.heard_seq[p.heard][1][0])
    decisions: list[_Decision] = []
    for li, sp in enumerate(lyr.specs):
        d = _Decision(total_keys=len(sp.seq))
        singers = sp.lyric.singers if sp.lyric else ()
        if marks_active and singers:
            d.for_this = "all" in singers or any(n.casefold() == folded for n in singers)
            d.other_singer = not d.for_this
        hs = sorted({h for _, h, _ in paired.get(li, [])}, key=lambda h: heard[h].start)
        clusters: list[list[int]] = []
        for h in hs:
            if clusters and heard[h].start - heard[clusters[-1][-1]].end > CLUSTER_GAP_SEC:
                clusters.append([h])
            else:
                if not clusters:
                    clusters.append([])
                clusters[-1].append(h)
        ex = exact_keys.get(li, [])
        best: set[int] = set()
        best_exact = -1
        for c in clusters:
            cs = set(c)
            n_exact = sum(1 for h in ex if h in cs)
            if n_exact > best_exact:
                best, best_exact = cs, n_exact
        d.exact_keys = max(best_exact, 0)
        share, least = (OTHER_SINGER_MIN_SHARE, OTHER_SINGER_MIN_KEYS) if d.other_singer else (PRESENT_MIN_SHARE, PRESENT_MIN_KEYS)
        need = max(math.ceil(share * d.total_keys), min(least, d.total_keys))
        if d.total_keys and d.exact_keys >= need:
            d.present = True
            d.cluster = best
            first = lyr.first_unit[li]
            for lu, h, exact in paired[li]:
                if h in best:
                    d.kept[lu - first] = max(d.kept.get(lu - first, 0.0), 1.0 if exact else 0.5)
            d.extent = (min(heard[h].start for h in best), max(heard[h].end for h in best))
        decisions.append(d)
    return decisions


def _split_pairs(lyr: _Lyrics, unit_pairs: list[Pair], decisions: list[_Decision]) -> list[Pair]:
    """Pairs that do not count (line not on the track, or outside its stretch) become one-sided."""
    out: list[Pair] = []
    for p in unit_pairs:
        if p.lyric is not None and p.heard is not None:
            d = decisions[lyr.line_of_unit[p.lyric]]
            if not (d.present and p.heard in d.cluster):
                out.append(Pair(p.lyric, None))
                out.append(Pair(None, p.heard))
                continue
        out.append(p)
    return out


def _expected_unit_times(
    lyr: _Lyrics, anchors: dict[int, tuple[float, float]], duration: float
) -> list[float]:
    """Where each lyric unit is expected, interpolated between anchor lines (by unit position)."""
    total = max(len(lyr.line_of_unit), 1)
    points: list[tuple[float, float]] = []
    for li in sorted(anchors):
        a, b = anchors[li]
        first = lyr.first_unit[li]
        points.append((float(first), a))
        points.append((float(first + len(lyr.specs[li].units)), b))
    mono: list[tuple[float, float]] = []
    for u, t in points:  # drop points that would make time run backwards
        if not mono or (u >= mono[-1][0] and t >= mono[-1][1]):
            mono.append((u, t))
    if len(mono) < 2 or mono[-1][0] <= mono[0][0]:
        mono = [(0.0, 0.0), (float(total), duration)]  # no anchors: spread the lyrics over the file
    rate = (mono[-1][1] - mono[0][1]) / (mono[-1][0] - mono[0][0]) or duration / total
    us = np.array([u for u, _ in mono])
    ts = np.array([t for _, t in mono])
    out = []
    for k in range(len(lyr.line_of_unit)):
        u = k + 0.5
        if u < us[0]:
            out.append(float(ts[0] - (us[0] - u) * rate))
        elif u > us[-1]:
            out.append(float(ts[-1] + (u - us[-1]) * rate))
        else:
            out.append(float(np.interp(u, us, ts)))
    return out


def _anchors(lyr: _Lyrics, decisions: list[_Decision]) -> dict[int, tuple[float, float]]:
    """Lines whose place in time is certain: on the track, and not one of several identical lines
    of which only some are on the track."""
    family_of = {li: f for f in lyr.families for li in f}
    out = {}
    for li, d in enumerate(decisions):
        if d.present and d.extent is not None and all(decisions[o].present for o in family_of.get(li, [li])):
            out[li] = d.extent
    return out


def _ambiguous(lyr: _Lyrics, decisions: list[_Decision]) -> bool:
    return any(len({decisions[li].present for li in f}) == 2 for f in lyr.families)


def _match(
    lyr: _Lyrics, tr: _Track, label: str | None, anchors: dict[int, tuple[float, float]] | None = None
) -> _Match:
    """Align the whole lyrics with what the track's recogniser heard, then decide every line.

    When identical lines (a repeated chorus) are only partly on the track, the alignment alone
    cannot tell which occurrence was sung; it is run again with a time prior from the lines whose
    place is certain (``anchors``, pooled over all tracks when given), or, with none, from the
    lyrics spread over the length of the file.
    """
    heard_keys = [k for k, _ in tr.heard_seq]
    heard_owners = [o for _, o in tr.heard_seq]
    key_pairs = align_keys(lyr.keys, heard_keys) if heard_keys else [Pair(i, None) for i in range(len(lyr.keys))]
    unit_pairs = project_pairs(key_pairs, lyr.key_owners, heard_owners)
    decisions = _decide(lyr, tr, key_pairs, unit_pairs, label)
    if heard_keys and _ambiguous(lyr, decisions):
        prior = anchors if anchors is not None else _anchors(lyr, decisions)
        expected = _expected_unit_times(lyr, prior, tr.duration)
        lyric_time = [expected[o[0]] for o in lyr.key_owners]
        heard_time = [(tr.heard[o[0]].start + tr.heard[o[0]].end) / 2 for o in heard_owners]
        key_pairs = align_keys(lyr.keys, heard_keys, lyric_time, heard_time)
        unit_pairs = project_pairs(key_pairs, lyr.key_owners, heard_owners)
        decisions = _decide(lyr, tr, key_pairs, unit_pairs, label)
    return _Match(_split_pairs(lyr, unit_pairs, decisions), decisions)


def _line_windows(windows: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    """Pad each line window but keep it away from the neighbouring lines."""
    out = []
    for i, (a, b) in enumerate(windows):
        lo = a - WINDOW_PAD
        hi = b + WINDOW_PAD
        if i > 0:
            prev_end = windows[i - 1][1]
            lo = max(lo, (prev_end + a) / 2 if prev_end < a else a)
        if i + 1 < len(windows):
            next_start = windows[i + 1][0]
            hi = min(hi, (b + next_start) / 2 if b < next_start else b)
        out.append((max(lo, 0.0), min(max(hi, lo + 0.05), duration)))
    return out


def _confidence(agree: float, dur: float, voiced: float, shift: float, window: float) -> float:
    dur_ok = 1.0 if dur >= 0.04 else max(dur / 0.04, 0.0)
    snap_ok = 1.0 - min(abs(shift) / max(window, 1e-6), 1.0)
    return round(0.4 * agree + 0.2 * dur_ok + 0.2 * min(voiced / 0.5, 1.0) + 0.2 * snap_ok, 3)


def _voiced_in(regions: Sequence[tuple[float, float]], a: float, b: float) -> tuple[float, float | None, float | None]:
    """Voiced time inside [a, b] and the first and last voiced instants there."""
    total, first, last = 0.0, None, None
    for ra, rb in regions:
        lo, hi = max(ra, a), min(rb, b)
        if hi > lo:
            total += hi - lo
            first = lo if first is None else first
            last = hi
    return total, first, last


def _lyrics_lines(
    x: np.ndarray,
    lyr: _Lyrics,
    tr: _Track,
    m: _Match,
    lang: str,
    aligner: AlignerBackend,
    label: str | None,
    warnings: list[str],
) -> tuple[list[_Line], list[dict[str, Any]], list[dict[str, Any]]]:
    """Lines with windows and aligned spans, the diffs, and the stretches of extra heard units."""
    heard = tr.heard
    specs = lyr.specs
    lines = [_Line(sp.text, sp.units, sp.lyric, sp.keys) for sp in specs]
    diffs: list[dict[str, Any]] = []
    decisions = m.decisions

    # Extra heard units: repeats of a line the lyrics list once, and the rest (ad-libs or unmatched).
    # The repeat check compares keys (morae for Japanese), so it is given the keys of unit ranges.
    line_keys = {(lyr.first_unit[li], lyr.first_unit[li] + len(sp.units)): sp.keys for li, sp in enumerate(specs)}

    def lyric_keys_of(a: int, b: int) -> list[str]:
        return line_keys.get((a, b)) or [k for k, o in zip(lyr.keys, lyr.key_owners) if a <= o[0] < b]

    def heard_keys_of(a: int, b: int) -> list[str]:
        return [k for k, o in tr.heard_seq if a <= o[0] < b]

    runs = find_runs(
        m.pairs,
        [""] * len(lyr.line_of_unit),
        [""] * len(heard),
        lyr.line_of_unit,
        lyric_keys_of=lyric_keys_of,
        heard_keys_of=heard_keys_of,
    )
    candidate = [False] * len(heard)
    items: list[dict[str, Any]] = []
    for r in runs:
        if r.heard is None:
            continue
        a, b = r.heard
        if r.kind == "repeat_unwritten" and r.repeat_of is not None:
            hs = heard[a:b]
            units = [h.unit for h in hs]
            items.append(
                {"kind": "repeat_unwritten", "text": units_text(units), "start": hs[0].start, "end": hs[-1].end,
                 "units": units, "spans": [(h.start, h.end) for h in hs]}
            )
            diffs.append(
                {"type": "repeat_unwritten", "text": units_text(units), "start": _r(hs[0].start), "end": _r(hs[-1].end),
                 "repeat_of_line": f"l{lyr.line_of_unit[r.repeat_of[0]] + 1}"}
            )
        else:
            for k in range(a, b):
                candidate[k] = True

    # Gap fill: one line without enough evidence between two lines on the track, with unexplained singing between them.
    marks_active, _ = _singer_marks(lyr, label)
    for li, d in enumerate(decisions):
        if d.present or not (0 < li < len(decisions) - 1):
            continue
        left, right = decisions[li - 1], decisions[li + 1]
        if not (left.present and right.present and left.extent and right.extent) or (marks_active and d.other_singer):
            continue
        ga, gb = left.extent[1] + GAP_MARGIN_SEC, right.extent[0] - GAP_MARGIN_SEC
        if gb <= ga:
            continue
        voiced, va, vb = _voiced_in(tr.regions, ga, gb)
        fillers = sum(h.end - h.start for k, h in enumerate(heard) if candidate[k] and ga <= h.start and h.end <= gb and is_filler(h.unit))
        if va is None or vb is None or voiced - fillers < max(GAP_FILL_MIN_VOICE_SEC, GAP_FILL_VOICE_PER_UNIT * len(specs[li].units)):
            continue
        ln = lines[li]
        ln.gap_filled = True
        ln.window = (va, vb)
        d.kept = {k: 0.2 for k in range(len(ln.units))}
        for k, h in enumerate(heard):
            if candidate[k] and va - 0.05 <= h.start and h.end <= vb + 0.05:
                candidate[k] = False
        warnings.append(
            f"line l{li + 1}: not recognised on this track; timed in the unidentified singing between l{li} and "
            f"l{li + 2}, so the times are a guess (conf at most {GAP_FILL_CONF_CAP})"
        )

    # Stretches of the remaining extra heard units.
    k = 0
    while k < len(heard):
        if not candidate[k]:
            k += 1
            continue
        j = k + 1
        while j < len(heard) and candidate[j] and heard[j].start - heard[j - 1].end <= UNMATCHED_JOIN_SEC:
            j += 1
        hs = heard[k:j]
        units = [h.unit for h in hs]
        items.append(
            {"kind": "extra", "text": units_text(units), "start": hs[0].start, "end": hs[-1].end, "units": units,
             "spans": [(h.start, h.end) for h in hs]}
        )
        k = j

    # Diffs: units of a line on the track that were not heard, and units heard differently.
    first_unit = lyr.first_unit
    for li, d in enumerate(decisions):
        ln = lines[li]
        if not (d.present or ln.gap_filled):
            ln.sung = False
            ln.absent_reason = "not_in_track"
            continue
        if d.present:
            groups: list[list[int]] = []
            for k in range(len(ln.units)):
                if k in d.kept:
                    continue
                if groups and k == groups[-1][-1] + 1:
                    groups[-1].append(k)
                else:
                    groups.append([k])
            for g in groups:
                diffs.append(
                    {"type": "not_sung", "line": f"l{li + 1}", "i": g[0] + 1,
                     "text": "".join(ln.units[k].text for k in g), "count": len(g)}
                )
    for p in m.pairs:
        if p.lyric is not None and p.heard is not None and not p.exact:
            li = lyr.line_of_unit[p.lyric]
            diffs.append(
                {"type": "heard_differently", "line": f"l{li + 1}", "i": p.lyric - first_unit[li] + 1,
                 "lyric": specs[li].units[p.lyric - first_unit[li]].text, "heard": heard[p.heard].unit.text}
            )
    for li, d in enumerate(decisions):
        sung = d.present or lines[li].gap_filled
        if d.for_this is not None and sung != d.for_this:
            diffs.append(
                {"type": "singer_mismatch", "line": f"l{li + 1}", "marked": list(specs[li].lyric.singers),  # type: ignore[union-attr]
                 "label": label, "heard": sung}
            )

    # Windows and alignment of every line that is on the track.
    on_track = [li for li, d in enumerate(decisions) if d.present or lines[li].gap_filled]
    raw = [decisions[li].extent if decisions[li].present else lines[li].window for li in on_track]
    padded = _line_windows([w for w in raw if w is not None], tr.duration)
    for li, win in zip(on_track, padded):
        ln = lines[li]
        kept = sorted(decisions[li].kept)
        ln.window = win
        ln.kept = kept
        ln.agree = [decisions[li].kept[k] for k in kept]
        a, b = win
        line_units = [ln.units[k] for k in kept]
        spans = aligner.align(_slice(x, a, b), a, b, line_units, line_language([u.text for u in line_units], lang))
        ln.spans = [(float(s), float(e)) for s, e in spans]
        ln.mismatch = getattr(aligner, "last_mismatch", None)
    return lines, diffs, items


def _lrc_lines(x: np.ndarray, lyr: _Lyrics, tr: _Track, lang: str, aligner: AlignerBackend) -> list[_Line]:
    """Nothing was recognised, but every line carries an LRC time: use those times as the windows."""
    lrc = [sp.lyric.lrc_time if sp.lyric else None for sp in lyr.specs]
    end = tr.chunks[-1][1] if tr.chunks else tr.duration
    raw = [(lrc[i], lrc[i + 1] if i + 1 < len(lrc) else max(end, lrc[i])) for i in range(len(lrc))]  # type: ignore[arg-type,operator]
    lines = []
    for sp, win in zip(lyr.specs, _line_windows(raw, tr.duration)):  # type: ignore[arg-type]
        ln = _Line(sp.text, sp.units, sp.lyric, sp.keys, window=win, kept=list(range(len(sp.units))))
        ln.agree = [0.2] * len(sp.units)
        spans = aligner.align(_slice(x, win[0], win[1]), win[0], win[1], sp.units, line_language([sp.text], lang))
        ln.spans = [(float(s), float(e)) for s, e in spans]
        ln.mismatch = getattr(aligner, "last_mismatch", None)
        lines.append(ln)
    return lines


def _asr_lines(heard: list[Heard], regions: Sequence[tuple[float, float]]) -> list[_Line]:
    """Without lyrics: one line per sung region, text exactly as recognised."""
    lines: list[_Line] = []
    for a, b in regions:
        members = [h for h in heard if a - 0.05 <= (h.start + h.end) / 2 <= b + 0.05]
        if not members:
            continue
        units = [h.unit for h in members]
        ln = _Line(units_text(units), units, keys=[u.key for u in units])
        ln.spans = [(h.start, h.end) for h in members]
        ln.agree = [1.0] * len(members)
        ln.kept = list(range(len(members)))
        ln.mismatch = next((h.mismatch for h in members if h.mismatch), None)
        lines.append(ln)
    return lines


# --- Output ------------------------------------------------------------------------------------


def _params(snap_window: float, notes_given: int) -> dict[str, Any]:
    return {
        "snap_window_sec": snap_window,
        "snap_priority": ["note", "onset"],
        "asr_chunk_max_sec": MAX_ASR_SEC,
        "align_window_max_sec": MAX_ALIGN_SEC,
        "vad": "energy+f0",
        "notes_given": notes_given,
        "line_presence": {
            "min_exact_key_share": PRESENT_MIN_SHARE,
            "min_exact_keys": PRESENT_MIN_KEYS,
            "other_singer_min_exact_key_share": OTHER_SINGER_MIN_SHARE,
            "other_singer_min_exact_keys": OTHER_SINGER_MIN_KEYS,
            "cluster_gap_sec": CLUSTER_GAP_SEC,
            "gap_fill_conf_cap": GAP_FILL_CONF_CAP,
        },
    }


def _empty_doc(
    tr: _Track, asr: AsrBackend, aligner: AlignerBackend, lyrics: str | None, snap_window: float, model_info: dict[str, Any] | None
) -> dict[str, Any]:
    inp = tr.inp
    return {
        "version": SCHEMA_VERSION,
        "generator": {"name": "lyrics-timeline", "version": __version__},
        "audio": {"name": inp.audio_name, "duration_sec": _r(tr.duration), "sample_rate": inp.sample_rate},
        "label": inp.label,
        "language": "auto",
        "language_source": None,
        "mode": "lyrics" if lyrics else "asr_only",
        "models": model_info or {"asr": asr.name, "aligner": aligner.name},
        "params": _params(snap_window, len(inp.notes)),
        "sections": [],
        "lines": [],
        "breaths": [],
        "adlibs": [],
        "unmatched": [],
        "diffs": [],
        "suspects": [],
        "warnings": [],
        "confidence": 0.0,
    }


def _track_doc(
    tr: _Track,
    lyr: _Lyrics | None,
    lang: str,
    source: str,
    asr: AsrBackend,
    aligner: AlignerBackend,
    lyrics: str | None,
    snap_window: float,
    model_info: dict[str, Any] | None,
    warnings: list[str],
) -> dict[str, Any]:
    """The single-track result for one track whose heard units are already timed."""
    inp = tr.inp
    x, feats, notes = inp.x, tr.feats, inp.notes
    out = _empty_doc(tr, asr, aligner, lyrics, snap_window, model_info)
    out["language"], out["language_source"] = lang, source
    out["warnings"] = warnings
    if inp.notes_requested and not notes:
        warnings.append(
            "--notes was given but no usable notes could be read from it; starts were not snapped to notes "
            "(acoustic onsets only)"
        )
    if not tr.chunks:
        warnings.append("no singing was found in the audio")
        return out
    if not tr.heard:
        warnings.append("the recogniser returned no text")
    note_starts = sorted(n.start for n in notes)
    onsets = detect_onsets(feats)
    diffs: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    if lyr is not None and not lyr.specs:
        warnings.append("the lyrics contain no singable text")
        lines: list[_Line] = []
    elif lyr is not None:
        lrc_ok = all(sp.lyric and sp.lyric.lrc_time is not None for sp in lyr.specs)
        if not tr.heard and lrc_ok:
            lines = _lrc_lines(x, lyr, tr, lang, aligner)
        else:
            assert tr.match is not None
            lines, diffs, items = _lyrics_lines(x, lyr, tr, tr.match, lang, aligner, inp.label, warnings)
            if not any(ln.sung for ln in lines):
                warnings.append("no lyric line could be located from the recognised text; no line was timed")
    else:
        lines = _asr_lines(tr.heard, tr.regions)
        out["needs_confirmation"] = True
    out["diffs"] = diffs

    # Tokens, snapping, confidence ---------------------------------------------------------
    line_records: list[dict[str, Any]] = []
    for li, ln in enumerate(lines):
        rec: dict[str, Any] = {
            "id": f"l{li + 1}",
            "text": ln.text,
            "start": None,
            "end": None,
            "section": None,
            "line_in_section": None,
            "sung": ln.sung and bool(ln.spans),
            "absent_reason": ln.absent_reason,
            "backing": bool(ln.lyric and ln.lyric.backing),
            "singers": list(ln.lyric.singers) if ln.lyric else [],
            "tokens": [],
        }
        if ln.lyric and ln.lyric.backing_text:
            diffs.append({"type": "backing_unaligned", "line": rec["id"], "text": ln.lyric.backing_text})
        if rec["sung"]:
            assert ln.spans is not None and ln.kept is not None and ln.agree is not None
            spans = [[a, b] for a, b in ln.spans]
            shifts: list[float] = []
            sources: list[str | None] = []
            for sp in spans:
                new, source_ = snap_start(sp[0], onsets, note_starts, snap_window)
                shifts.append(new - sp[0])
                sources.append(source_)
                sp[0] = new
            enforce_order(spans)
            if ln.mismatch:
                warnings.append(
                    f"line {rec['id']}: aligner returned {ln.mismatch[0]} spans for {ln.mismatch[1]} units; "
                    "times are approximate"
                )
            cap = min(APPROX_CONF_CAP if ln.mismatch else 1.0, GAP_FILL_CONF_CAP if ln.gap_filled else 1.0)
            for k, sp in enumerate(spans):
                unit = ln.units[ln.kept[k]]
                vs = voiced_start(sp[0], sp[1], feats)
                tok: dict[str, Any] = {
                    "i": ln.kept[k] + 1,  # position in the written line, as in the not_sung diff
                    "text": unit.text,
                    "start": _r(sp[0]),
                    "voiced_start": _r(max(vs, sp[0])),
                    "end": _r(sp[1]),
                    "conf": min(
                        _confidence(
                            ln.agree[k], sp[1] - sp[0], voiced_ratio(sp[0], sp[1], feats), shifts[k], snap_window
                        ),
                        cap,
                    ),
                    "type": "char" if unit.kind == "char" else "word",
                    "snap": {"source": sources[k], "shift_sec": _r(shifts[k])},
                    "notes": split_by_notes(sp[0], sp[1], notes) if sp[1] - sp[0] >= LONG_NOTE_SPLIT_MIN else [],
                }
                rec["tokens"].append(tok)
            rec["start"] = rec["tokens"][0]["start"]
            rec["end"] = max(t["end"] for t in rec["tokens"])
            rec["conf"] = round(sum(t["conf"] for t in rec["tokens"]) / len(rec["tokens"]), 3)
        line_records.append(rec)

    # Extra heard units: inside a line's time range or short or only fillers -> ad-lib of that
    # line; a longer stretch outside every line -> unmatched[] (ask the user what it is) -------
    for item in items:
        host = next(
            (r for r in line_records if r["start"] is not None and r["start"] - 0.05 <= item["start"] <= r["end"] + 0.05),
            None,
        )
        if item["kind"] == "extra" and host is None and len(item["units"]) >= UNMATCHED_MIN_UNITS and not all(
            is_filler(u) for u in item["units"]
        ):
            out["unmatched"].append({"start": _r(item["start"]), "end": _r(item["end"]), "heard_text": item["text"]})
            continue
        kind = "repeat_unwritten" if item["kind"] == "repeat_unwritten" else "adlib"
        if kind == "adlib":
            diffs.append({"type": "adlib", "text": item["text"], "start": _r(item["start"]), "end": _r(item["end"])})
        out["adlibs"].append(
            {"line": host["id"] if host else None, "text": item["text"], "start": _r(item["start"]),
             "end": _r(item["end"]), "kind": kind}
        )
        if host:
            for u, (a, b) in zip(item["units"], item["spans"]):
                host["tokens"].append(
                    {
                        "i": None,
                        "text": u.text,
                        "start": _r(a),
                        "voiced_start": _r(voiced_start(a, b, feats)),
                        "end": _r(b),
                        "conf": 0.5,
                        "type": "repeat" if kind == "repeat_unwritten" else "adlib",
                        "snap": {"source": None, "shift_sec": 0.0},
                        "notes": [],
                    }
                )
            host["tokens"].sort(key=lambda t: t["start"])
    out["adlibs"].sort(key=lambda a: a["start"])
    out["unmatched"].sort(key=lambda a: a["start"])

    # Sections -----------------------------------------------------------------------------
    infos = []
    prev_end = None
    for ln, rec in zip(lines, line_records):
        info = LineInfo(keys=list(ln.keys))
        if ln.lyric:
            info.label, info.label_number, info.block = ln.lyric.label, ln.lyric.label_number, ln.lyric.block
        if rec["start"] is not None:
            a, b = feats.frame_at(rec["start"]), feats.frame_at(rec["end"])
            info.start, info.end = rec["start"], rec["end"]
            info.gap_before = None if prev_end is None else rec["start"] - prev_end
            if b > a:
                info.level_db = float(feats.rms_db[a:b].mean())
                f0 = feats.f0[a:b]
                info.f0 = float(f0[f0 > 0].mean()) if (f0 > 0).any() else None
            prev_end = rec["end"]
        infos.append(info)
    for si, plan in enumerate(plan_sections(infos)):
        sid = f"s{si + 1}"
        members = [line_records[i] for i in plan.lines]
        timed = [m for m in members if m["start"] is not None]
        confs = [m["conf"] for m in timed if "conf" in m]
        out["sections"].append(
            {
                "id": sid,
                "label": plan.label,
                "occurrence": plan.occurrence,
                "start": min((m["start"] for m in timed), default=None),
                "end": max((m["end"] for m in timed), default=None),
                "lines": [m["id"] for m in members],
                "source": plan.source,
                "conf": round(plan.conf * (sum(confs) / len(confs) if confs else 0.0), 3),
            }
        )
        for n, m in enumerate(members, start=1):
            m["section"], m["line_in_section"] = sid, n
    out["lines"] = line_records

    out["breaths"] = [{"start": _r(a), "end": _r(b)} for a, b in detect_breaths(feats, tr.regions)]

    # No reference lyrics: list characters that are easy to confuse, never rewrite them -------
    if not lyrics:
        for rec in line_records:
            for tok in rec["tokens"]:
                alts = homophone_alternatives(tok["text"]) if tok["type"] == "char" and lang in ("zh", "yue") else []
                if alts or tok["conf"] < 0.5:
                    out["suspects"].append(
                        {
                            "line": rec["id"],
                            "i": tok["i"],
                            "text": tok["text"],
                            "alternatives": alts,
                            "reason": "homophone" if alts else "low_confidence",
                        }
                    )
    confs = [r["conf"] for r in line_records if "conf" in r]
    out["confidence"] = round(sum(confs) / len(confs), 3) if confs else 0.0
    return out


def _run(
    inputs: Sequence[TrackInput],
    asr: AsrBackend,
    aligner: AlignerBackend,
    lyrics: str | None,
    language: str,
) -> tuple[list[_Track], _Lyrics | None, str, str, list[str]]:
    """Recognise every track, settle the language, time the heard units and match the lyrics."""
    tracks = [_analyse(inp) for inp in inputs]
    asr_language = asr_language_for(language, lyrics)
    for i, tr in enumerate(tracks):
        asr.start_track(i)
        _transcribe(tr, asr, asr_language)
    lang, source, shared = decide_language(
        language, lyrics, [r for tr in tracks for r in tr.reported], " ".join(t for tr in tracks for t in tr.texts)
    )
    if lang == "ja" and not have_readings():
        shared.append(
            "Japanese readings (SudachiPy with SudachiDict-core) are not installed, so kanji and kana are compared "
            "as written: a word the recogniser writes in other characters counts as a mismatch. Run scripts/setup.py "
            "--yes again to install them."
        )
    for i, tr in enumerate(tracks):
        aligner.start_track(i)
        _time_heard(tr, aligner, lang)
    lyr = _prepare_lyrics(lyrics, lang, shared) if lyrics else None
    if lyr is not None and lyr.specs:
        for tr in tracks:
            tr.match = _match(lyr, tr, tr.inp.label)
        if len(tracks) > 1 and any(tr.match and _ambiguous(lyr, tr.match.decisions) for tr in tracks):
            # Tracks of one song share its timeline: pool the lines whose place is certain.
            pooled: dict[int, list[tuple[float, float]]] = {}
            for tr in tracks:
                for li, ext in _anchors(lyr, tr.match.decisions).items():  # type: ignore[union-attr]
                    pooled.setdefault(li, []).append(ext)
            anchors = {li: (median(a for a, _ in v), median(b for _, b in v)) for li, v in pooled.items()}
            for tr in tracks:
                if tr.match and _ambiguous(lyr, tr.match.decisions):
                    tr.match = _match(lyr, tr, tr.inp.label, anchors)
    return tracks, lyr, lang, source, shared


def build_timeline(
    x: np.ndarray,
    asr: AsrBackend,
    aligner: AlignerBackend,
    lyrics: str | None = None,
    notes: Sequence[Note] = (),
    language: str = "auto",
    snap_window: float = DEFAULT_SNAP_WINDOW,
    audio_name: str = "",
    sample_rate: int = TARGET_SR,
    model_info: dict[str, Any] | None = None,
    notes_requested: bool = False,
    label: str | None = None,
) -> dict[str, Any]:
    """Build the timeline for 16 kHz mono audio ``x`` (see SKILL.md for the output fields)."""
    inp = TrackInput(x, audio_name, sample_rate, label, notes, notes_requested)
    tracks, lyr, lang, source, shared = _run([inp], asr, aligner, lyrics, language)
    return _track_doc(tracks[0], lyr, lang, source, asr, aligner, lyrics, snap_window, model_info, shared)


def build_multitrack(
    inputs: Sequence[TrackInput],
    asr: AsrBackend,
    aligner: AlignerBackend,
    lyrics: str | None = None,
    language: str = "auto",
    snap_window: float = DEFAULT_SNAP_WINDOW,
    model_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One result for several tracks of one song: which lyric line is sung on which track, and when."""
    tracks, lyr, lang, source, shared = _run(inputs, asr, aligner, lyrics, language)
    docs = []
    for i, tr in enumerate(tracks):
        doc = _track_doc(tr, lyr, lang, source, asr, aligner, lyrics, snap_window, model_info, [])
        docs.append({"track": f"t{i + 1}", **doc})
    warnings = list(shared)
    for inp in inputs:
        if inp.label and lyr is not None and any(sp.lyric and sp.lyric.singers for sp in lyr.specs):
            if not _singer_marks(lyr, inp.label)[0]:
                warnings.append(
                    f"track label {inp.label!r} appears in no singer mark of the lyrics; that track is judged by "
                    "the audio alone"
                )
    if not lyrics:
        warnings.append("no lyrics were given, so lyric_lines is empty; each track lists what was recognised")
    lyric_lines = []
    for li, sp in enumerate(lyr.specs if lyr else []):
        lid = f"l{li + 1}"
        sung_by = []
        for doc in docs:
            rec = doc["lines"][li] if li < len(doc["lines"]) else None  # a silent track has no lines
            if rec and rec["sung"]:
                sung_by.append({"track": doc["track"], "line": rec["id"], "start": rec["start"], "end": rec["end"], "conf": rec["conf"]})
        lyric_lines.append({"id": lid, "text": sp.text, "singers": list(sp.lyric.singers) if sp.lyric else [], "sung_by": sung_by})
    return {
        "version": SCHEMA_VERSION,
        "generator": {"name": "lyrics-timeline", "version": __version__},
        "mode": "multi_track",
        "language": lang,
        "language_source": source,
        "models": model_info or {"asr": asr.name, "aligner": aligner.name},
        "params": _params(snap_window, 0),
        "lyric_lines": lyric_lines,
        "tracks": docs,
        "warnings": warnings,
    }
