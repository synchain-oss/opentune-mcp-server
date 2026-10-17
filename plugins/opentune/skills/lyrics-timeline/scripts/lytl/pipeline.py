# SPDX-License-Identifier: MIT
"""The timeline pipeline: VAD, recognition, lyric comparison, alignment, snapping, sections.

One audio file is one track. A track may sing only part of the lyrics (one of several lead
singers, a harmony that sings only the chorus), so every lyric line is first checked against what
the recogniser heard on that track: a line with too little evidence is reported as not on the
track (or as not recognised, when the track has unexplained singing where the line would be)
instead of being spread into a gap and force-aligned there. Tracks of one song share a timeline:
a line sung on several tracks is sung at about the same time on each.
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
from .seqalign import Pair, align_keys, align_within, find_runs, project_pairs
from .sections import LineInfo, plan_sections
from .snap import DEFAULT_SNAP_WINDOW, Note, enforce_order, snap_start, split_by_notes

WINDOW_PAD = 0.25
LONG_NOTE_SPLIT_MIN = 0.3  # only tokens at least this long get notes[] sub-segments
# When the aligner returned a different number of spans than we gave it units, its spans were
# resampled onto the units. Every token of such a line gets conf of at most this value, which is
# below the 0.5 at which SKILL.md tells the model to ask the user first.
APPROX_CONF_CAP = 0.4
# The aligner sometimes returns a span of zero length for a unit it could not place (the start of
# the next unit then follows after a pause). Such a unit takes the time up to the next unit's start
# (at most ZERO_SPREAD_MAX_SEC per unit), and its conf is capped at APPROX_CONF_CAP; so is the conf
# of a token that snapping left shorter than ZERO_SPAN_SEC.
ZERO_SPAN_SEC = 0.02
ZERO_SPREAD_MAX_SEC = 1.0
# A heard unit whose span the aligner put more than this outside the recognised chunk it came
# from is moved back into that chunk (see _keep_in_chunks).
CHUNK_SLACK_SEC = 0.5

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
# are separate stretches, unless they follow each other directly in one recognised chunk: slow
# singing, and units that the aligner placed badly (a zero-length span seconds away from the
# sound), stay one stretch. Only the stretch with the most exact keys counts.
CLUSTER_GAP_SEC = 3.0
# A line without enough evidence between two lines that are on the track is still timed when the
# gap between them holds singing that nothing else explains: at least this much voice per unit of
# the line (and GAP_FILL_MIN_VOICE_SEC overall), measured GAP_MARGIN_SEC inside the gap. With one
# track and no singer mark naming it, a run of several such lines is timed too, the gap shared by
# their unit counts; with several tracks only a single line is, so that a vocalise between two
# lines is never taken for missing lyrics, and never a line another track sings at that time. A
# gap whose heard text is other words (see NOT_RECOGNISED_MIN_SHARE) is not filled either.
GAP_FILL_VOICE_PER_UNIT = 0.15
GAP_FILL_MIN_VOICE_SEC = 0.5
GAP_MARGIN_SEC = 0.3
GAP_FILL_CONF_CAP = 0.45  # below the 0.5 at which the model asks the user
# Heard units that match no lyric line: stretches closer than this are one stretch; a stretch of
# at least UNMATCHED_MIN_UNITS units that is not only fillers goes to unmatched[], shorter ones
# stay ad-libs.
UNMATCHED_JOIN_SEC = 1.0
UNMATCHED_MIN_UNITS = 3
# Heard text is "other words" than some lines when it has at least UNMATCHED_MIN_UNITS units
# besides fillers and shares fewer than NOT_RECOGNISED_MIN_SHARE of the lines' keys (and fewer than
# NOT_RECOGNISED_MIN_KEYS) when compared on its own with them; such text is never filled with them.
# Why a line has no times. "not_recognised": the track has singing nothing explains where the line
# would be (at least GAP_FILL_MIN_VOICE_SEC), the text heard there is not other words and shares at
# least one key with the line; or, on a track given alone, nothing at all was recognised in that
# singing and it is long enough for the line (GAP_FILL_VOICE_PER_UNIT). Otherwise "not_in_track":
# silence there, other words, or singing without words next to tracks that sing the line (on real
# stems, humming and held notes; flagging those buried the few lines that were really missed).
NOT_RECOGNISED_MIN_SHARE = 0.25
NOT_RECOGNISED_MIN_KEYS = 2
# The end of a line goes back to it from the echo line after it only when it follows the line
# without a pause: at most this many median unit lengths of the track without voice between them
# (see _return_echo_tails). The median leaves out units without length: the aligner often gives a
# held unit none, and on a track where most units have none it would be zero, so that a few frames
# without voice at the edges of the units' times would refuse every hand-back. The pause allowed is
# never shorter than ECHO_MIN_PAUSE_SEC (also its value when no unit has a length); that floor is
# below the 0.35 s under which the voice activity bridges a gap, so a pause it shows still counts.
ECHO_MAX_PAUSE_UNITS = 1.5
ECHO_MIN_PAUSE_SEC = 0.3

# --- A second look at lines that were not found ---------------------------------------------------
# The whole-song alignment lets every missing line compete for the same leftover sounds, so a line
# can lose its sounds one by one to lines that are not on the track. Each line not found is also
# compared on its own with the heard units that no found line explains, between the found lines
# around it (and, with several tracks, near where the others sing it). Stretches of those units
# made only of fillers (あ, ねえ, oh, 啊) are left out: a harmony's ad-libs are full of them, and a
# short line made of the same sounds would be found there by chance. It needs the same share of
# exact keys, but at least SECOND_PASS_MIN_KEYS of them (all of a shorter line): a short line that
# may pick its stretch freely matches by chance more easily.
SECOND_PASS_MIN_KEYS = 3
# With several tracks, an unbroken run of at least PARTIAL_MIN_KEYS exact keys at the time the
# other tracks sing the line also counts (a harmony often joins for part of a line only).
PARTIAL_MIN_KEYS = 4
# Lines found by the second look always get conf below 0.5, the point at which SKILL.md tells the
# model to ask the user first, however much of the line matched: the line was found only by being
# compared on its own with what was left over. Shorter lines match leftovers by chance more easily,
# so a line of fewer than SECOND_PASS_SHORT_KEYS keys gets SECOND_PASS_CONF_LOW, and each key
# beyond that adds SECOND_PASS_CONF_STEP, up to SECOND_PASS_CONF_HIGH (reached at 12 keys).
SECOND_PASS_SHORT_KEYS = 6
SECOND_PASS_CONF_LOW = 0.35
SECOND_PASS_CONF_STEP = 0.02
SECOND_PASS_CONF_HIGH = 0.49

# --- Several tracks: one shared timeline -------------------------------------------------------
# Stems of one song are normally exported from the same start. Each track's offset from the others
# is estimated from the lines it shares with them (at least OFFSET_MIN_LINES); when those lines
# disagree by more than OFFSET_MAX_SPREAD_SEC (median deviation), the tracks do not share one
# timeline and nothing below is applied. Offsets within OFFSET_ZERO_SEC count as zero.
OFFSET_MIN_LINES = 3
OFFSET_MAX_SPREAD_SEC = 1.5
OFFSET_ZERO_SEC = 1.5
# Placements of one line on several tracks within CONSENSUS_GROUP_SEC are one placement. The
# shared timeline is the heaviest chain of placements (weight: exact keys) whose times follow the
# lyric order; a later line may start ORDER_SLACK_SEC before an earlier one (overlapping singers).
CONSENSUS_GROUP_SEC = 4.0
ORDER_SLACK_SEC = 5.0
# A line heard on a track further than this from where the timeline has it does not count on that
# track (a vocalise that happens to sound like a short line elsewhere in the song), unless at
# least CROSS_TRACK_STRONG_KEYS of its keys (and OTHER_SINGER_MIN_SHARE of them) were heard exactly.
# Measured on real stems: lines sung together on several tracks start within about 1.5 s of each
# other, and lines between two placed lines stay inside the gap between them.
CROSS_TRACK_MAX_DEV_SEC = 8.0
CROSS_TRACK_STRONG_KEYS = 8


@dataclass
class Heard:
    unit: Unit
    start: float
    end: float
    mismatch: tuple[int, int] | None = None  # (spans returned, units given) when the aligner had to be resampled
    chunk: int = 0  # the recognised chunk the unit comes from


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
    cap: float = 1.0  # conf cap of every token of the line
    rough: set[int] = field(default_factory=set)  # token positions whose zero-length span was spread


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
    unit_keys: list[list[int]] = field(default_factory=list)  # heard unit -> its keys (by first owner)
    match: _Match | None = None
    warnings: list[str] = field(default_factory=list)
    ctx: _Context | None = None


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
    key_start: list[int] = field(default_factory=list)  # first key of each line
    unit_keys: list[list[int]] = field(default_factory=list)  # lyric unit -> its keys (by first owner)

    def line_keys(self, li: int) -> range:
        end = self.key_start[li + 1] if li + 1 < len(self.key_start) else len(self.keys)
        return range(self.key_start[li], end)


@dataclass
class _Decision:
    present: bool = False
    cluster: set[int] = field(default_factory=set)  # heard units that count for the line
    kept: dict[int, float] = field(default_factory=dict)  # local unit index -> agreement
    pairs: list[tuple[int, int, bool]] = field(default_factory=list)  # (lyric unit, heard unit, exact) that count
    extent: tuple[float, float] | None = None
    exact_keys: int = 0
    total_keys: int = 0
    other_singer: bool = False
    for_this: bool | None = None  # marked for this track (None: no usable mark)
    second: float | None = None  # share of exact keys when found by the second look
    partial: bool = False  # found by the second look as part of a line sung on other tracks


@dataclass
class _Match:
    pairs: list[Pair]  # unit pairs after the decisions (pairs of lines not on the track split up)
    decisions: list[_Decision]


@dataclass
class _Timeline:
    """Where the tracks sing each line, on the shared clock (a track's time minus its offset)."""

    offsets: list[float | None]  # None: the track is left out of the comparison across tracks
    windows: list[tuple[float, float] | None]  # where each line is expected
    tracks_of: list[set[int]]  # tracks whose placement of the line is the timeline's


@dataclass
class _Context:
    """What the other tracks say, for one track (times on this track's clock)."""

    expected: list[tuple[float, float] | None]  # where each line is expected on this track
    elsewhere: dict[int, list[tuple[float, float]]]  # line -> where other tracks sing it


def _slice(x: np.ndarray, a: float, b: float) -> np.ndarray:
    return x[max(int(a * TARGET_SR), 0) : max(int(b * TARGET_SR), 0)]


def _r(v: float) -> float:
    return round(float(v), 3)


def _need(total: int, share: float, least: int) -> int:
    return max(math.ceil(share * total), min(least, total))


def _clusters(heard: list[Heard], hs: Sequence[int]) -> list[list[int]]:
    """Heard units (in heard order) split into stretches; see CLUSTER_GAP_SEC."""
    out: list[list[int]] = []
    for h in hs:
        p = out[-1][-1] if out else -1
        next_heard = h == p + 1 and heard[h].chunk == heard[p].chunk
        if out and not next_heard and heard[h].start - heard[p].end > CLUSTER_GAP_SEC:
            out.append([h])
        elif out:
            out[-1].append(h)
        else:
            out.append([h])
    return out


def _voice(
    regions: Sequence[tuple[float, float]], a: float, b: float, minus: Sequence[tuple[float, float]] = ()
) -> tuple[float, float | None, float | None]:
    """Voiced time inside [a, b] outside the ``minus`` intervals, and its first and last instants."""
    pieces = [(max(ra, a), min(rb, b)) for ra, rb in regions if min(rb, b) > max(ra, a)]
    for ma, mb in sorted(minus):
        cut: list[tuple[float, float]] = []
        for pa, pb in pieces:
            if mb <= pa or ma >= pb:
                cut.append((pa, pb))
                continue
            if ma > pa:
                cut.append((pa, ma))
            if mb < pb:
                cut.append((mb, pb))
        pieces = cut
    if not pieces:
        return 0.0, None, None
    return sum(pb - pa for pa, pb in pieces), pieces[0][0], pieces[-1][1]


def _split_voice(
    regions: Sequence[tuple[float, float]], a: float, b: float, weights: Sequence[int], minus: Sequence[tuple[float, float]]
) -> list[tuple[float, float]]:
    """Cut the voiced time in [a, b] into consecutive windows in proportion to ``weights``."""
    total, first, last = _voice(regions, a, b, minus)
    assert first is not None and last is not None
    out: list[tuple[float, float]] = []
    lo = first
    acc = 0
    whole = sum(weights)
    for w in weights:
        acc += w
        if acc == whole:
            out.append((lo, last))
            break
        target = total * acc / whole
        # The instant at which ``target`` seconds of voice have passed since ``first``.
        t_lo, t_hi = lo, last
        for _ in range(30):
            mid = (t_lo + t_hi) / 2
            if _voice(regions, first, mid, minus)[0] < target:
                t_lo = mid
            else:
                t_hi = mid
        out.append((lo, t_hi))
        lo = t_hi
    return out


def _spread_zero_spans(spans: list[tuple[float, float]], end: float) -> tuple[list[tuple[float, float]], set[int]]:
    """Give units with a zero-length span the time up to the next unit's start (see ZERO_SPAN_SEC)."""
    out = list(spans)
    rough: set[int] = set()
    k = 0
    while k < len(out):
        if out[k][1] - out[k][0] >= ZERO_SPAN_SEC:
            k += 1
            continue
        j = k
        while j < len(out) and out[j][1] - out[j][0] < ZERO_SPAN_SEC:
            j += 1
        a = out[k][0]
        b = out[j][0] if j < len(out) else end
        b = min(b, a + ZERO_SPREAD_MAX_SEC * (j - k))
        if b - a >= ZERO_SPAN_SEC * (j - k):
            step = (b - a) / (j - k)
            for q in range(k, j):
                out[q] = (a + (q - k) * step, a + (q - k + 1) * step)
        rough.update(range(k, j))
        k = j
    return out, rough


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


def _keep_in_chunks(spans: list[tuple[float, float]], bounds: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Put units the aligner placed outside the chunk they were heard in back into it.

    One alignment window covers several recognised chunks and the silence between them; the
    aligner sometimes places the first words of a chunk in the previous one, seconds or a minute
    away. Such units are spread evenly between their neighbours inside the chunk.
    """
    out = list(spans)
    bad = [not (ca - CHUNK_SLACK_SEC <= (a + b) / 2 <= cb + CHUNK_SLACK_SEC) for (a, b), (ca, cb) in zip(spans, bounds)]
    k = 0
    while k < len(out):
        if not bad[k]:
            k += 1
            continue
        j = k
        while j < len(out) and bad[j] and bounds[j] == bounds[k]:
            j += 1
        ca, cb = bounds[k]
        lo = out[k - 1][1] if k > 0 and bounds[k - 1] == bounds[k] else ca
        hi = out[j][0] if j < len(out) and bounds[j] == bounds[k] and not bad[j] else cb
        lo, hi = max(lo, ca), max(min(hi, cb), max(lo, ca))
        step = (hi - lo) / (j - k)
        for q in range(k, j):
            out[q] = (lo + (q - k) * step, lo + (q - k + 1) * step)
        k = j
    return out


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
        spans = _keep_in_chunks(
            [(float(a), float(b)) for a, b in spans[: len(units)]],
            [tr.chunks[c] for c in group for _ in chunk[c][0]],
        )
        owner_chunk = [c for c in group for _ in chunk[c][0]]
        for u, (a, b), c in zip(units, spans, owner_chunk):
            tr.heard.append(Heard(u, float(a), float(b), mismatch, c))
    tr.unit_keys = [[] for _ in tr.heard]
    for q, (_, owners) in enumerate(tr.heard_seq):
        tr.unit_keys[owners[0]].append(q)


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
    key_start: list[int] = []
    for li, sp in enumerate(specs):
        first_unit.append(len(line_of_unit))
        key_start.append(len(keys))
        for key, owners in sp.seq:
            keys.append(key)
            key_owners.append(tuple(first_unit[li] + o for o in owners))
            key_line.append(li)
        line_of_unit.extend([li] * len(sp.units))
    by_keys: dict[tuple[str, ...], list[int]] = {}
    for li, sp in enumerate(specs):
        by_keys.setdefault(tuple(sp.keys), []).append(li)
    families = [f for f in by_keys.values() if len(f) >= 2]
    unit_keys: list[list[int]] = [[] for _ in line_of_unit]
    for k, owners in enumerate(key_owners):
        unit_keys[owners[0]].append(k)
    return _Lyrics(specs, line_of_unit, first_unit, keys, key_owners, key_line, families, key_start, unit_keys)


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


def _thresholds(d: _Decision) -> tuple[float, int]:
    return (OTHER_SINGER_MIN_SHARE, OTHER_SINGER_MIN_KEYS) if d.other_singer else (PRESENT_MIN_SHARE, PRESENT_MIN_KEYS)


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
        ex = exact_keys.get(li, [])
        best: set[int] = set()
        best_exact = -1
        for c in _clusters(heard, sorted({h for _, h, _ in paired.get(li, [])})):
            cs = set(c)
            n_exact = sum(1 for h in ex if h in cs)
            if n_exact > best_exact:
                best, best_exact = cs, n_exact
        d.exact_keys = max(best_exact, 0)
        if d.total_keys and d.exact_keys >= _need(d.total_keys, *_thresholds(d)):
            d.present = True
            d.cluster = best
            first = lyr.first_unit[li]
            for lu, h, exact in paired[li]:
                if h in best:
                    d.kept[lu - first] = max(d.kept.get(lu - first, 0.0), 1.0 if exact else 0.5)
                    d.pairs.append((lu, h, exact))
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


def _echo_max_pause(heard: Sequence[Heard]) -> float:
    """The longest pause without voice after which the end of a line still goes back to it.

    ECHO_MAX_PAUSE_UNITS times the median length of the heard units that have a length, and never
    less than ECHO_MIN_PAUSE_SEC.
    """
    lengths = [h.end - h.start for h in heard if h.end > h.start]
    return max(ECHO_MAX_PAUSE_UNITS * median(lengths), ECHO_MIN_PAUSE_SEC) if lengths else ECHO_MIN_PAUSE_SEC


def _return_echo_tails(
    lyr: _Lyrics, tr: _Track, key_pairs: list[Pair], label: str | None
) -> tuple[list[Pair], list[_Decision]] | None:
    """Give a line back the end that the next, echo-like line took from it.

    Lyrics often write a short echo of the end of a line as its own next line ("... night" then
    "night", sung by another voice). On the track of the main line the alignment may pair the heard
    end with the echo line instead (both cost the same). The echo line's matches go back to the line
    when all of these hold: the line's unmatched tail has exactly the keys of the echo line; the
    echo line's matches are the heard keys right after the line's last match, every one of them;
    and between that last match and the first of them the track is silent for no more than
    ECHO_MAX_PAUSE_UNITS median unit lengths of this track (see _echo_max_pause). That is the end of
    the line sung straight on, not an echo sung after a pause while the end of the line was not
    recognised. The pause is measured on the voice activity, not on the times of the units, because
    the aligner often gives the last, held unit of a line no length at all (on real stems the next
    unit then starts two to four unit lengths later, with voice all the way). The change is kept
    only when the line is then on the track.
    """
    heard_owners = [o for _, o in tr.heard_seq]
    max_pause = _echo_max_pause(tr.heard)
    pos = {p.lyric: i for i, p in enumerate(key_pairs) if p.lyric is not None}
    changed: tuple[list[Pair], list[_Decision]] | None = None
    pairs = key_pairs
    for lb in range(1, len(lyr.specs)):
        la_keys, lb_keys = lyr.line_keys(lb - 1), lyr.line_keys(lb)
        matched = [k for k in la_keys if pairs[pos[k]].heard is not None]
        if not matched:
            continue
        tail = list(range(matched[-1] + 1, la_keys.stop))
        if len(tail) != len(lb_keys) or [lyr.keys[k] for k in tail] != [lyr.keys[k] for k in lb_keys]:
            continue
        heard_b = [pairs[pos[k]].heard for k in lb_keys]
        last = pairs[pos[matched[-1]]].heard
        assert last is not None
        if heard_b != list(range(last + 1, last + 1 + len(heard_b))):
            continue
        a, b = tr.heard[max(heard_owners[last])].end, tr.heard[min(heard_owners[last + 1])].start
        if b > a and (b - a) - _voice(tr.regions, a, b)[0] > max_pause:
            continue
        moved = list(pairs)
        for k, kb, h in zip(tail, lb_keys, heard_b):
            moved[pos[k]] = Pair(k, h, pairs[pos[kb]].exact)
            moved[pos[kb]] = Pair(kb, None)
        unit_pairs = project_pairs(moved, lyr.key_owners, heard_owners)
        decisions_after = _decide(lyr, tr, moved, unit_pairs, label)
        if decisions_after[lb - 1].present:
            pairs = moved
            changed = (moved, decisions_after)
    return changed


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
    if heard_keys:
        echo = _return_echo_tails(lyr, tr, key_pairs, label)
        if echo is not None:
            key_pairs, decisions = echo
            unit_pairs = project_pairs(key_pairs, lyr.key_owners, heard_owners)
    return _Match(_split_pairs(lyr, unit_pairs, decisions), decisions)


def _second_look(lyr: _Lyrics, tr: _Track, label: str | None, timeline: _Timeline | None, t: int) -> None:
    """Look again for each line not found, among the heard units that no found line explains.

    The candidates of a run of missing lines are the leftover heard units between the found lines
    around the run; with a shared timeline, only those near where the line is expected. The line
    with the highest share of exact keys is taken first, then the others, in order.
    """
    assert tr.match is not None
    ds = tr.match.decisions
    heard = tr.heard
    if not heard:
        return
    off = timeline.offsets[t] if timeline else None
    explained = {h for d in ds if d.present for h in d.cluster}
    li = 0
    while li < len(ds):
        if ds[li].present:
            li += 1
            continue
        run_end = li
        while run_end < len(ds) and not ds[run_end].present:
            run_end += 1
        lo = ds[li - 1].extent[1] if li > 0 and ds[li - 1].extent else -1.0  # type: ignore[index]
        hi = ds[run_end].extent[0] if run_end < len(ds) and ds[run_end].extent else math.inf  # type: ignore[index]
        free = _without_filler_stretches(
            heard, [h for h in range(len(heard)) if h not in explained and lo <= (heard[h].start + heard[h].end) / 2 <= hi]
        )
        taken: list[tuple[int, int, int]] = []  # (line, first heard, last heard) found in this run
        candidates = set(range(li, run_end))
        while candidates and free:
            best: tuple[float, int, _Decision] | None = None
            for k in sorted(candidates):
                d = _look_for(lyr, tr, k, ds[k], free, timeline, off, taken)
                if d is not None and (best is None or (d.second or 0.0) > best[0]):
                    best = (d.second or 0.0, k, d)
            if best is None:
                break
            _, k, d = best
            candidates.discard(k)
            ds[k] = d
            free = [h for h in free if h not in d.cluster]
            explained |= d.cluster
            taken.append((k, min(d.cluster), max(d.cluster)))
            what = (
                f"only part of it was heard on this track ({d.exact_keys} of {d.total_keys} sounds), where the other "
                "tracks sing it; the rest is listed as not sung"
                if d.partial
                else f"found only by a second, line-by-line comparison ({d.exact_keys} of {d.total_keys} sounds heard exactly)"
            )
            tr.warnings.append(f"line l{k + 1}: {what}; check it (conf at most {_second_cap(d)})")
        li = run_end


def _without_filler_stretches(heard: list[Heard], hs: list[int]) -> list[int]:
    """``hs`` without its stretches made only of fillers: ad-libs such as あ, ねえ, oh or 啊.

    A stretch is a run of units of ``hs`` that follow each other in what was heard, at most
    UNMATCHED_JOIN_SEC apart. A filler inside a stretch with other words stays: in Japanese a
    kana such as え or あ is also part of ordinary words (まえ, うえ).
    """
    out: list[int] = []
    run: list[int] = []
    for h in [*hs, None]:
        if run and (h is None or h != run[-1] + 1 or heard[h].start - heard[run[-1]].end > UNMATCHED_JOIN_SEC):
            if not all(is_filler(heard[k].unit) for k in run):
                out.extend(run)
            run = []
        if h is not None:
            run.append(h)
    return out


def _second_cap(d: _Decision) -> float:
    """The conf cap of a line found by the second look; see SECOND_PASS_CONF_LOW."""
    extra = max(0, d.total_keys - SECOND_PASS_SHORT_KEYS + 1)
    return round(min(SECOND_PASS_CONF_HIGH, SECOND_PASS_CONF_LOW + SECOND_PASS_CONF_STEP * extra), 3)


def _look_for(
    lyr: _Lyrics,
    tr: _Track,
    li: int,
    old: _Decision,
    free: list[int],
    timeline: _Timeline | None,
    off: float | None,
    taken: list[tuple[int, int, int]],
) -> _Decision | None:
    """Line ``li`` compared on its own with the free heard units; a decision when it is found."""
    heard = tr.heard
    window = timeline.windows[li] if timeline and off is not None else None
    hs = free
    if window is not None:
        lo, hi = window[0] + off - CROSS_TRACK_MAX_DEV_SEC, window[1] + off + CROSS_TRACK_MAX_DEV_SEC  # type: ignore[operator]
        hs = [h for h in hs if lo <= (heard[h].start + heard[h].end) / 2 <= hi]
    # Keep the order of the lines found in this run.
    after = max((last for k, _, last in taken if k < li), default=-1)
    before = min((first for k, first, _ in taken if k > li), default=len(heard))
    hs = [h for h in hs if after < h < before]
    if not hs:
        return None
    hk = [q for h in hs for q in tr.unit_keys[h]]
    if not hk:
        return None
    keys = lyr.line_keys(li)
    local = align_within([lyr.keys[k] for k in keys], [tr.heard_seq[q][0] for q in hk])
    key_pairs = [Pair(keys[p.lyric], hk[p.heard], p.exact) for p in local if p.lyric is not None and p.heard is not None]
    unit_pairs = project_pairs(key_pairs, lyr.key_owners, [o for _, o in tr.heard_seq])
    paired = [(p.lyric, p.heard, p.exact) for p in unit_pairs if p.lyric is not None and p.heard is not None]
    if not paired:
        return None
    exact_heard = [tr.heard_seq[p.heard][1][0] for p in key_pairs if p.exact]
    best: set[int] = set()
    best_exact = -1
    for c in _clusters(heard, sorted({h for _, h, _ in paired})):
        n_exact = sum(1 for h in exact_heard if h in c)
        if n_exact > best_exact:
            best, best_exact = set(c), n_exact
    total = len(keys)
    share, least = _thresholds(old)
    found = best_exact >= _need(total, share, max(least, SECOND_PASS_MIN_KEYS))
    partial = False
    if not found and window is not None and timeline is not None and timeline.tracks_of[li]:
        run = longest = 0  # longest unbroken run of exact keys inside the stretch
        for p in local:
            if p.lyric is None:
                continue
            run = run + 1 if p.exact and p.heard is not None and tr.heard_seq[hk[p.heard]][1][0] in best else 0
            longest = max(longest, run)
        partial = found = longest >= PARTIAL_MIN_KEYS and not old.other_singer
    if not found:
        return None
    d = _Decision(
        present=True, cluster=best, exact_keys=best_exact, total_keys=total, other_singer=old.other_singer,
        for_this=old.for_this, second=best_exact / total, partial=partial,
    )
    first = lyr.first_unit[li]
    for lu, h, exact in paired:
        if h in best:
            d.kept[lu - first] = max(d.kept.get(lu - first, 0.0), 1.0 if exact else 0.5)
            d.pairs.append((lu, h, exact))
    d.extent = (min(heard[h].start for h in best), max(heard[h].end for h in best))
    return d


# --- Several tracks ----------------------------------------------------------------------------


def _placement(tr: _Track, d: _Decision) -> tuple[float, float, float]:
    """(start, end, middle) of a line on a track; the middle is the median of its heard units."""
    assert d.extent is not None
    mids = sorted((tr.heard[h].start + tr.heard[h].end) / 2 for h in d.cluster)
    return d.extent[0], d.extent[1], mids[len(mids) // 2]


def _outside(t: float, window: tuple[float, float]) -> float:
    return max(0.0, window[0] - t, t - window[1])


def _offset_reference(offsets: dict[int, float], shared: dict[int, int]) -> float:
    """The offset that counts as zero, from the tracks' offsets and how many lines each shares.

    Tracks whose offsets are all within OFFSET_ZERO_SEC of each other form a group. When one group
    is larger than every other, the middle of its offsets is the reference: the tracks then named as
    offset are those off from most of the others (a lead exported 10 s late next to two harmonies in
    time is named, not the two harmonies, though the lead shares the most lines). When several
    groups are equally large (two tracks that disagree, for one), one track of them is the
    reference: the one that shares the most lines with the others; on a tie, the one nearest to the
    middle of all offsets; then the first. Taking the middle of all offsets instead would split one
    track's offset between the two of a pair (10 s as 5 s each, 2.9 s as 1.45 s each, which is then
    within OFFSET_ZERO_SEC on both).
    """
    order = sorted(offsets, key=lambda t: (offsets[t], t))
    groups = [[u for u in order[i:] if offsets[u] - offsets[t] <= OFFSET_ZERO_SEC] for i, t in enumerate(order)]
    size = max(len(g) for g in groups)
    largest = [g for g in groups if len(g) == size]
    if len(largest) == 1:
        return median(offsets[t] for t in largest[0])
    middle = median(offsets.values())
    tied = {t for g in largest for t in g}
    return offsets[min(tied, key=lambda t: (-shared[t], round(abs(offsets[t] - middle), 3), t))]


def _shared_timeline(lyr: _Lyrics, tracks: list[_Track], warnings: list[str]) -> _Timeline | None:
    """Offsets of the tracks and where each line is expected; None when the tracks disagree."""
    n = len(tracks)
    places = [
        {li: _placement(tr, d) for li, d in enumerate(tr.match.decisions) if d.present and d.extent}  # type: ignore[union-attr]
        for tr in tracks
    ]
    offsets: list[float] = [0.0] * n
    spread: dict[int, float] = {}
    shared: dict[int, int] = {}  # track -> how many of its lines other tracks sing too
    for _ in range(3):  # a few rounds settle the offsets of tracks that share lines with each other
        for t in range(n):
            diffs = []
            for li, (_, _, mid) in places[t].items():
                others = [places[u][li][2] - offsets[u] for u in range(n) if u != t and li in places[u]]
                if others:
                    diffs.append(mid - median(others))
            if len(diffs) >= OFFSET_MIN_LINES:
                offsets[t] = median(diffs)
                spread[t] = median(abs(x - offsets[t]) for x in diffs)
                shared[t] = len(diffs)
    if not spread:
        return None
    bad = sorted(t for t, s in spread.items() if s > OFFSET_MAX_SPREAD_SEC)
    if bad:
        warnings.append(
            "the tracks do not seem to share one timeline (the lines they have in common are sung at inconsistent "
            f"times on {', '.join(f't{t + 1}' for t in bad)}), so each track was matched on its own, without "
            "comparing times across tracks; export every stem from the same start to get that check"
        )
        return None
    # The offsets above share an arbitrary constant; see _offset_reference for what counts as zero.
    base = _offset_reference({t: offsets[t] for t in spread}, shared)
    known = {t: offsets[t] - base for t in spread}
    same_start = all(abs(o) <= OFFSET_ZERO_SEC for o in known.values())
    final: list[float | None] = []
    for t in range(n):
        if t in known:
            final.append(0.0 if abs(known[t]) <= OFFSET_ZERO_SEC else known[t])
        else:
            final.append(0.0 if same_start else None)
    for t, o in sorted(known.items()):
        if abs(o) > OFFSET_ZERO_SEC:
            warnings.append(
                f"track t{t + 1} seems to run {abs(o):.1f} s {'later' if o > 0 else 'earlier'} than the other tracks "
                "(judged from the lines they share); its times are compared after removing that offset and are "
                "reported unchanged"
            )
    left_out = [t for t in range(n) if final[t] is None]
    if left_out:
        warnings.append(
            f"{', '.join(f't{t + 1}' for t in left_out)} share too few lines with the other tracks to tell their offset; "
            "they are matched on their own, without comparing times across tracks"
        )

    # Placements of each line, grouped, then the heaviest chain in lyric and time order.
    groups: list[tuple[int, float, float, float, int, set[int]]] = []  # (line, middle, start, end, weight, tracks)
    for li in range(len(lyr.specs)):
        pts = sorted(
            (places[t][li][2] - o, places[t][li][0] - o, places[t][li][1] - o, tracks[t].match.decisions[li].exact_keys, t)  # type: ignore[union-attr]
            for t in range(n)
            if (o := final[t]) is not None and li in places[t]
        )
        cur: list[tuple[float, float, float, int, int]] = []
        for p in pts + [None]:  # type: ignore[list-item]
            if cur and (p is None or p[0] - cur[-1][0] > CONSENSUS_GROUP_SEC):
                groups.append(
                    (li, median(c[0] for c in cur), median(c[1] for c in cur), median(c[2] for c in cur),
                     sum(c[3] for c in cur), {c[4] for c in cur})
                )
                cur = []
            if p is not None:
                cur.append(p)
    best = [g[4] for g in groups]
    prev = [-1] * len(groups)
    for i, g in enumerate(groups):
        for j in range(i):
            h = groups[j]
            if h[0] < g[0] and g[1] >= h[1] - ORDER_SLACK_SEC and best[j] + g[4] > best[i]:
                best[i], prev[i] = best[j] + g[4], j
    chosen: dict[int, tuple[int, float, float, float, int, set[int]]] = {}
    i = max(range(len(groups)), key=lambda q: best[q]) if groups else -1
    while i >= 0:
        chosen[groups[i][0]] = groups[i]
        i = prev[i]
    windows: list[tuple[float, float] | None] = [None] * len(lyr.specs)
    tracks_of: list[set[int]] = [set() for _ in lyr.specs]
    for li, g in chosen.items():
        windows[li] = (g[2], g[3])
        tracks_of[li] = set(g[5])
    placed = sorted(chosen)
    for a, b in zip(placed, placed[1:]):
        if b - a < 2:
            continue
        lo, hi = sorted((chosen[a][3], chosen[b][2]))
        weights = [len(lyr.specs[k].units) for k in range(a + 1, b)]
        pos = lo
        for k, w in zip(range(a + 1, b), weights):
            seg = (hi - lo) * w / sum(weights)
            windows[k] = (pos, pos + seg)
            pos += seg
    return _Timeline(final, windows, tracks_of)


def _reject_far(lyr: _Lyrics, tracks: list[_Track], timeline: _Timeline) -> None:
    """Lines heard far from where the timeline has them do not count on that track."""
    for t, tr in enumerate(tracks):
        off = timeline.offsets[t]
        m = tr.match
        if off is None or m is None:
            continue
        changed = False
        for li, d in enumerate(m.decisions):
            window = timeline.windows[li]
            if not d.present or window is None or t in timeline.tracks_of[li]:
                continue
            mid = _placement(tr, d)[2]
            strong = d.exact_keys >= max(CROSS_TRACK_STRONG_KEYS, math.ceil(OTHER_SINGER_MIN_SHARE * d.total_keys))
            if _outside(mid - off, window) > CROSS_TRACK_MAX_DEV_SEC and not strong:
                m.decisions[li] = _Decision(total_keys=d.total_keys, other_singer=d.other_singer, for_this=d.for_this)
                changed = True
                tr.warnings.append(
                    f"line l{li + 1}: heard around {mid:.1f} s, but the other tracks sing it around "
                    f"{window[0] + off:.1f} s; not counted on this track"
                )
        if changed:
            m.pairs = _split_pairs(lyr, m.pairs, m.decisions)


def _contexts(lyr: _Lyrics, tracks: list[_Track], timeline: _Timeline | None) -> None:
    """For each track: where the timeline expects each line, and where the other tracks sing it."""
    places = [
        {li: _placement(tr, d)[:2] for li, d in enumerate(tr.match.decisions) if d.present and d.extent}  # type: ignore[union-attr]
        for tr in tracks
    ]
    for t, tr in enumerate(tracks):
        off = timeline.offsets[t] if timeline else None
        shift = (lambda u: (off or 0.0) - (timeline.offsets[u] or 0.0)) if timeline and off is not None else (lambda u: 0.0)
        elsewhere: dict[int, list[tuple[float, float]]] = {}
        for u, pl in enumerate(places):
            if u != t and (timeline is None or timeline.offsets[u] is not None or off is None):
                for li, (a, b) in pl.items():
                    elsewhere.setdefault(li, []).append((a + shift(u), b + shift(u)))
        expected: list[tuple[float, float] | None] = [None] * len(lyr.specs)
        if timeline and off is not None:
            expected = [None if w is None else (w[0] + off, w[1] + off) for w in timeline.windows]
        tr.ctx = _Context(expected, elsewhere)


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


def _heard_share(lyr: _Lyrics, tr: _Track, lines: Sequence[int], hs: Sequence[int]) -> tuple[int, int]:
    """(exact keys, keys) of ``lines`` compared on their own with the heard units ``hs``."""
    keys = [k for li in lines for k in lyr.line_keys(li)]
    hk = [tr.heard_seq[q][0] for h in hs for q in tr.unit_keys[h]]
    if not keys or not hk:
        return 0, len(keys)
    return sum(1 for p in align_within([lyr.keys[k] for k in keys], hk) if p.exact), len(keys)


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
    multi = tr.ctx is not None

    # Extra heard units: repeats of a line the lyrics list once, and the rest (ad-libs or unmatched).
    # The repeat check compares keys (morae for Japanese), so it is given the keys of unit ranges.
    def lyric_keys_of(a: int, b: int) -> list[str]:
        return [lyr.keys[k] for k in sorted(k for u in range(a, b) for k in lyr.unit_keys[u])]

    def heard_keys_of(a: int, b: int) -> list[str]:
        return [tr.heard_seq[q][0] for q in sorted(q for h in range(a, b) for q in tr.unit_keys[h])]

    runs = find_runs(
        m.pairs,
        [""] * len(lyr.line_of_unit),
        [""] * len(heard),
        lyr.line_of_unit,
        lyric_keys_of=lyric_keys_of,
        heard_keys_of=heard_keys_of,
    )
    explained = {h for d in decisions if d.present for h in d.cluster}
    candidate = [False] * len(heard)
    items: list[dict[str, Any]] = []
    for r in runs:
        if r.heard is None:
            continue
        a, b = r.heard
        # A stretch part of which the second look gave to a line is no repeat; the rest is extra.
        if r.kind == "repeat_unwritten" and r.repeat_of is not None and not explained.intersection(range(a, b)):
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
                candidate[k] = k not in explained

    def fillers_in(a: float, b: float) -> list[tuple[float, float]]:
        return [(h.start, h.end) for k, h in enumerate(heard) if candidate[k] and a <= h.start and h.end <= b and is_filler(h.unit)]

    def words_in(a: float, b: float) -> list[int]:
        return [k for k, h in enumerate(heard) if candidate[k] and a <= (h.start + h.end) / 2 <= b and not is_filler(h.unit)]

    def other_words(lis: Sequence[int], hs: Sequence[int]) -> bool:
        """The heard units are clearly other words than the lines (too few shared keys)."""
        if len(hs) < UNMATCHED_MIN_UNITS:
            return False
        exact, total = _heard_share(lyr, tr, lis, hs)
        return exact < max(NOT_RECOGNISED_MIN_KEYS, math.ceil(NOT_RECOGNISED_MIN_SHARE * total))

    # Gap fill: lines without enough evidence between two lines on the track, with unexplained
    # singing between them (see GAP_FILL_VOICE_PER_UNIT).
    marks_active, _ = _singer_marks(lyr, label)
    li = 0
    while li < len(decisions):
        if decisions[li].present:
            li += 1
            continue
        j = li
        while j < len(decisions) and not decisions[j].present:
            j += 1
        run = list(range(li, j))
        li = j
        if run[0] == 0 or j == len(decisions):
            continue
        left, right = decisions[run[0] - 1].extent, decisions[j].extent
        if left is None or right is None:
            continue
        if len(run) == 1:
            k = run[0]
            if marks_active and decisions[k].other_singer:
                continue
        elif multi or marks_active:
            continue
        ga, gb = left[1] + GAP_MARGIN_SEC, right[0] - GAP_MARGIN_SEC
        if gb <= ga:
            continue
        if multi and any(min(b, gb) > max(a, ga) for k in run for a, b in tr.ctx.elsewhere.get(k, [])):  # type: ignore[union-attr]
            continue  # another track sings the line there: it is that track's line
        minus = fillers_in(ga, gb)
        voiced, va, vb = _voice(tr.regions, ga, gb, minus)
        n_units = sum(len(specs[k].units) for k in run)
        if va is None or vb is None or voiced < max(GAP_FILL_MIN_VOICE_SEC, GAP_FILL_VOICE_PER_UNIT * n_units):
            continue
        if other_words(run, words_in(ga, gb)):
            continue
        shares = _split_voice(tr.regions, ga, gb, [len(specs[k].units) for k in run], minus)
        for k, win in zip(run, shares):
            ln = lines[k]
            ln.gap_filled = True
            ln.window = win
            ln.cap = GAP_FILL_CONF_CAP
            decisions[k].kept = {q: 0.2 for q in range(len(ln.units))}
            between = f"between l{run[0]} and l{j + 1}"
            how = f"{between} (shared with the other lines of that gap by unit count)" if len(run) > 1 else between
            warnings.append(
                f"line l{k + 1}: not recognised on this track; timed in the unidentified singing {how}, so the "
                f"times are a guess (conf at most {GAP_FILL_CONF_CAP})"
            )
        for q, h in enumerate(heard):
            if candidate[q] and va - 0.05 <= h.start and h.end <= vb + 0.05:
                candidate[q] = False

    # Why each remaining line has no times (see NOT_RECOGNISED_MIN_SHARE).
    on_track = [k for k, d in enumerate(decisions) if d.present or lines[k].gap_filled]
    covered = [decisions[k].extent if decisions[k].present else lines[k].window for k in on_track]
    absent = [k for k in range(len(decisions)) if k not in set(on_track)]
    where: dict[int, tuple[float, float]] = {}
    k = 0
    while k < len(absent):  # without a timeline: the gap between the lines around, shared by unit count
        j = k
        while j + 1 < len(absent) and absent[j + 1] == absent[j] + 1:
            j += 1
        first, last = absent[k], absent[j]
        lo = max((w[1] for q, w in zip(on_track, covered) if q < first and w), default=0.0)
        hi = min((w[0] for q, w in zip(on_track, covered) if q > last and w), default=tr.duration)
        if hi > lo:
            weights = [len(specs[q].units) for q in range(first, last + 1)]
            pos = lo
            for q, w in zip(range(first, last + 1), weights):
                seg = (hi - lo) * w / sum(weights)
                where[q] = (pos, pos + seg)
                pos += seg
        k = j + 1
    def why_absent(k: int, win: tuple[float, float] | None) -> str:
        if win is None:
            return "not_in_track"
        a, b = win[0] - GAP_MARGIN_SEC, win[1] + GAP_MARGIN_SEC
        voice = _voice(tr.regions, a, b, [w for w in covered if w] + fillers_in(a, b))[0]
        if voice < GAP_FILL_MIN_VOICE_SEC:
            return "not_in_track"  # silence there
        hs = words_in(a, b)
        if not hs:
            # Singing without any recognised word. With one track it may be the line, missed
            # entirely; next to other tracks that sing the line it is taken for humming or a held
            # note, which stems are full of.
            enough = voice >= GAP_FILL_VOICE_PER_UNIT * len(specs[k].units)
            return "not_recognised" if not multi and enough else "not_in_track"
        if other_words([k], hs):
            return "not_in_track"
        return "not_recognised" if _heard_share(lyr, tr, [k], hs)[0] >= 1 else "not_in_track"

    for k in absent:
        ln = lines[k]
        ln.sung = False
        ln.absent_reason = why_absent(k, tr.ctx.expected[k] if tr.ctx and tr.ctx.expected[k] else where.get(k))

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
        if not d.present:
            continue
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
    for li, d in enumerate(decisions):
        for lu, h, exact in d.pairs if d.present else []:
            if not exact:
                diffs.append(
                    {"type": "heard_differently", "line": f"l{li + 1}", "i": lu - first_unit[li] + 1,
                     "lyric": specs[li].units[lu - first_unit[li]].text, "heard": heard[h].unit.text}
                )
    for li, d in enumerate(decisions):
        sung = d.present or lines[li].gap_filled
        if d.for_this is not None and sung != d.for_this:
            diffs.append(
                {"type": "singer_mismatch", "line": f"l{li + 1}", "marked": list(specs[li].lyric.singers),  # type: ignore[union-attr]
                 "label": label, "heard": sung}
            )

    # Windows and alignment of every line that is on the track.
    order = sorted(on_track, key=lambda q: covered[on_track.index(q)][0])  # type: ignore[index]
    padded = _line_windows([covered[on_track.index(q)] for q in order], tr.duration)  # type: ignore[misc]
    for li, win in zip(order, padded):
        ln = lines[li]
        d = decisions[li]
        kept = sorted(d.kept)
        ln.window = win
        ln.kept = kept
        ln.agree = [d.kept[k] for k in kept]
        if d.second is not None:
            ln.cap = _second_cap(d)
        a, b = win
        line_units = [ln.units[k] for k in kept]
        spans = aligner.align(_slice(x, a, b), a, b, line_units, line_language([u.text for u in line_units], lang))
        ln.spans, ln.rough = _spread_zero_spans([(float(s), float(e)) for s, e in spans], b)
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
        ln.spans, ln.rough = _spread_zero_spans([(float(s), float(e)) for s, e in spans], win[1])
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
            "second_look_min_exact_keys": SECOND_PASS_MIN_KEYS,
            "cross_track_max_deviation_sec": CROSS_TRACK_MAX_DEV_SEC,
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
    warnings.extend(tr.warnings)
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
        aligned = bool(ln.spans)
        if ln.sung and not aligned:
            warnings.append(
                f"line l{li + 1}: found on this track, but the aligner returned no times for it "
                "(absent_reason no_alignment)"
            )
        rec: dict[str, Any] = {
            "id": f"l{li + 1}",
            "text": ln.text,
            "start": None,
            "end": None,
            "section": None,
            "line_in_section": None,
            "sung": ln.sung and aligned,
            # A line found on the track that the aligner gave no times is not sung as far as the
            # result goes; it still says why.
            "absent_reason": "no_alignment" if ln.sung and not aligned else ln.absent_reason,
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
            cap = min(APPROX_CONF_CAP if ln.mismatch else 1.0, ln.cap)
            for k, sp in enumerate(spans):
                unit = ln.units[ln.kept[k]]
                vs = voiced_start(sp[0], sp[1], feats)
                tok: dict[str, Any] = {
                    "i": ln.kept[k] + 1,  # position in the written line, as in the not_sung diff
                    "text": unit.text,
                    "start": _r(sp[0]),
                    "voiced_start": _r(min(max(vs, sp[0]), sp[1])),
                    "end": _r(sp[1]),
                    "conf": min(
                        _confidence(
                            ln.agree[k], sp[1] - sp[0], voiced_ratio(sp[0], sp[1], feats), shifts[k], snap_window
                        ),
                        cap,
                        # spread over a zero-length span, or squeezed to (almost) nothing between
                        # its neighbours by snapping: the times of the unit are a guess
                        APPROX_CONF_CAP if k in ln.rough or sp[1] - sp[0] < ZERO_SPAN_SEC else 1.0,
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
                        # voiced_start works on 10 ms frames; keep it inside a span between frames
                        "voiced_start": _r(min(max(voiced_start(a, b, feats), a), b)),
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
    if lyr is None or not lyr.specs:
        return tracks, lyr, lang, source, shared
    for tr in tracks:
        tr.match = _match(lyr, tr, tr.inp.label)
    timeline = None
    if len(tracks) > 1:
        if any(tr.match and _ambiguous(lyr, tr.match.decisions) for tr in tracks):
            # Tracks of one song share its timeline: pool the lines whose place is certain.
            pooled: dict[int, list[tuple[float, float]]] = {}
            for tr in tracks:
                for li, ext in _anchors(lyr, tr.match.decisions).items():  # type: ignore[union-attr]
                    pooled.setdefault(li, []).append(ext)
            anchors = {li: (median(a for a, _ in v), median(b for _, b in v)) for li, v in pooled.items()}
            for tr in tracks:
                if tr.match and _ambiguous(lyr, tr.match.decisions):
                    tr.match = _match(lyr, tr, tr.inp.label, anchors)
        timeline = _shared_timeline(lyr, tracks, shared)
        if timeline is not None:
            _reject_far(lyr, tracks, timeline)
    for t, tr in enumerate(tracks):
        _second_look(lyr, tr, tr.inp.label, timeline, t)
    if len(tracks) > 1:
        _contexts(lyr, tracks, timeline)
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
        aligner.start_track(i)  # each line is aligned again on its own track
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
