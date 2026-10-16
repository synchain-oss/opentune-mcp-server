# SPDX-License-Identifier: MIT
"""The timeline pipeline: VAD, recognition, lyric comparison, alignment, snapping, sections."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from . import SCHEMA_VERSION, __version__
from .audio import (
    MAX_ALIGN_SEC,
    MAX_ASR_SEC,
    TARGET_SR,
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
from .lyrics import LyricLine, parse_lyrics
from .normalize import (
    Unit,
    detect_language,
    homophone_alternatives,
    is_filler,
    tokenize,
    units_text,
)
from .seqalign import Pair, Run, align_keys, find_runs
from .sections import LineInfo, plan_sections
from .snap import DEFAULT_SNAP_WINDOW, Note, enforce_order, snap_start, split_by_notes

WINDOW_PAD = 0.25
LONG_NOTE_SPLIT_MIN = 0.3  # only tokens at least this long get notes[] sub-segments
# When the aligner returned a different number of spans than we gave it units, its spans were
# resampled onto the units. Every token of such a line gets conf of at most this value, which is
# below the 0.5 at which SKILL.md tells the model to ask the user first.
APPROX_CONF_CAP = 0.4


@dataclass
class Heard:
    unit: Unit
    start: float
    end: float
    mismatch: tuple[int, int] | None = None  # (spans returned, units given) when the aligner had to be resampled


@dataclass
class _Line:
    """A line under construction."""

    text: str
    units: list[Unit]
    lyric: LyricLine | None = None
    window: tuple[float, float] | None = None
    sung: bool = True
    spans: list[tuple[float, float]] | None = None
    agree: list[float] | None = None
    kept: list[int] | None = None  # indexes into units that were aligned (others are not sung)
    mismatch: tuple[int, int] | None = None  # (spans returned, units given) when the aligner had to be resampled


def _slice(x: np.ndarray, a: float, b: float) -> np.ndarray:
    return x[max(int(a * TARGET_SR), 0) : max(int(b * TARGET_SR), 0)]


def _r(v: float) -> float:
    return round(float(v), 3)


def hear(
    x: np.ndarray,
    chunks: Sequence[tuple[float, float]],
    asr: AsrBackend,
    aligner: AlignerBackend,
    language: str,
) -> tuple[list[Heard], str]:
    """Recognise every chunk, then time the recognised units window by window."""
    texts = [asr.transcribe(_slice(x, a, b), a, b, language) for a, b in chunks]
    lang = language
    if lang == "auto":
        lang = detect_language(" ".join(texts))
    chunk_units = [tokenize(t, lang) for t in texts]
    heard: list[Heard] = []
    for group in group_windows(list(chunks), MAX_ALIGN_SEC):
        units = [u for c in group for u in chunk_units[c]]
        if not units:
            continue
        ws, we = chunks[group[0]][0], chunks[group[-1]][1]
        spans = aligner.align(_slice(x, ws, we), ws, we, units, lang)
        mismatch = getattr(aligner, "last_mismatch", None)
        for u, (a, b) in zip(units, spans):
            heard.append(Heard(u, float(a), float(b), mismatch))
    return heard, lang


def _window_from_pairs(
    pairs: list[Pair], line_of_unit: list[int], heard: list[Heard], n_lines: int
) -> list[tuple[float, float] | None]:
    lo: list[float | None] = [None] * n_lines
    hi: list[float | None] = [None] * n_lines
    for p in pairs:
        if p.lyric is None or p.heard is None:
            continue
        line = line_of_unit[p.lyric]
        h = heard[p.heard]
        lo[line] = h.start if lo[line] is None else min(lo[line], h.start)  # type: ignore[type-var]
        hi[line] = h.end if hi[line] is None else max(hi[line], h.end)  # type: ignore[type-var]
    return [(lo[i], hi[i]) if lo[i] is not None else None for i in range(n_lines)]  # type: ignore[misc]


def _fill_windows(
    windows: list[tuple[float, float] | None],
    unit_counts: list[int],
    span: tuple[float, float],
) -> list[tuple[float, float]]:
    """Give every line a window: known ones as they are, the rest spread between known neighbours."""
    n = len(windows)
    out: list[tuple[float, float] | None] = list(windows)
    i = 0
    while i < n:
        if out[i] is not None:
            i += 1
            continue
        j = i
        while j < n and out[j] is None:
            j += 1
        left = out[i - 1][1] if i > 0 else span[0]  # type: ignore[index]
        right = out[j][0] if j < n else span[1]  # type: ignore[index]
        if right < left:
            right = left
        weight = sum(max(unit_counts[k], 1) for k in range(i, j))
        t = left
        for k in range(i, j):
            seg = (right - left) * max(unit_counts[k], 1) / weight
            out[k] = (t, t + seg)
            t += seg
        i = j
    return [w for w in out if w is not None]  # type: ignore[misc]


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
) -> dict[str, Any]:
    """Build the timeline for 16 kHz mono audio ``x`` (see SKILL.md for the output fields)."""
    feats = frame_features(x)
    duration = x.size / TARGET_SR
    regions = energy_vad(feats)
    chunks = split_chunks(regions, feats, MAX_ASR_SEC)
    warnings: list[str] = []
    note_starts = sorted(n.start for n in notes)
    onsets = detect_onsets(feats)
    out: dict[str, Any] = {
        "version": SCHEMA_VERSION,
        "generator": {"name": "lyrics-timeline", "version": __version__},
        "audio": {"name": audio_name, "duration_sec": _r(duration), "sample_rate": sample_rate},
        "language": language,
        "mode": "lyrics" if lyrics else "asr_only",
        "models": model_info or {"asr": asr.name, "aligner": aligner.name},
        "params": {
            "snap_window_sec": snap_window,
            "snap_priority": ["note", "onset"],
            "asr_chunk_max_sec": MAX_ASR_SEC,
            "align_window_max_sec": MAX_ALIGN_SEC,
            "vad": "energy+f0",
            "notes_given": len(notes),
        },
        "sections": [],
        "lines": [],
        "breaths": [],
        "adlibs": [],
        "diffs": [],
        "suspects": [],
        "warnings": warnings,
        "confidence": 0.0,
    }
    if not chunks:
        warnings.append("no singing was found in the audio")
        return out
    heard, lang = hear(x, chunks, asr, aligner, language)
    out["language"] = lang
    if not heard:
        warnings.append("the recogniser returned no text")

    if lyrics:
        lines, runs, pairs, diffs, adlib_items = _lyrics_lines(
            x, lyrics, heard, lang, aligner, chunks, duration, warnings
        )
    else:
        lines, runs, pairs, diffs, adlib_items = _asr_lines(heard, regions), [], [], [], []
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
            "backing": bool(ln.lyric and ln.lyric.backing),
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
                new, source = snap_start(sp[0], onsets, note_starts, snap_window)
                shifts.append(new - sp[0])
                sources.append(source)
                sp[0] = new
            enforce_order(spans)
            if ln.mismatch:
                warnings.append(
                    f"line {rec['id']}: aligner returned {ln.mismatch[0]} spans for {ln.mismatch[1]} units; "
                    "times are approximate"
                )
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
                        APPROX_CONF_CAP if ln.mismatch else 1.0,
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

    # Ad-libs and unwritten repeats go into the line whose time range holds them -------------
    for item in adlib_items:
        host = next(
            (r for r in line_records if r["start"] is not None and r["start"] - 0.05 <= item["start"] <= r["end"] + 0.05),
            None,
        )
        entry = {
            "line": host["id"] if host else None,
            "text": item["text"],
            "start": _r(item["start"]),
            "end": _r(item["end"]),
            "kind": item["kind"],
        }
        out["adlibs"].append(entry)
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
                        "type": "repeat" if item["kind"] == "repeat_unwritten" else "adlib",
                        "snap": {"source": None, "shift_sec": 0.0},
                        "notes": [],
                    }
                )
            host["tokens"].sort(key=lambda t: t["start"])
    out["adlibs"].sort(key=lambda a: a["start"])

    # Sections -----------------------------------------------------------------------------
    infos = []
    prev_end = None
    for ln, rec in zip(lines, line_records):
        info = LineInfo(keys=[u.key for u in ln.units])
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

    out["breaths"] = [{"start": _r(a), "end": _r(b)} for a, b in detect_breaths(feats, regions)]

    # No reference lyrics: list characters that are easy to confuse, never rewrite them -------
    if not lyrics:
        for rec in line_records:
            for tok in rec["tokens"]:
                alts = homophone_alternatives(tok["text"]) if tok["type"] == "char" else []
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


def _unit_at(lines: list[_Line], line_of_unit: list[int], first_unit: dict[int, int], k: int) -> Unit:
    li = line_of_unit[k]
    return lines[li].units[k - first_unit[li]]


def _asr_lines(heard: list[Heard], regions: Sequence[tuple[float, float]]) -> list[_Line]:
    """Without lyrics: one line per sung region, text exactly as recognised."""
    lines: list[_Line] = []
    for a, b in regions:
        members = [h for h in heard if a - 0.05 <= (h.start + h.end) / 2 <= b + 0.05]
        if not members:
            continue
        units = [h.unit for h in members]
        ln = _Line(units_text(units), units)
        ln.spans = [(h.start, h.end) for h in members]
        ln.agree = [1.0] * len(members)
        ln.kept = list(range(len(members)))
        ln.mismatch = next((h.mismatch for h in members if h.mismatch), None)
        lines.append(ln)
    return lines


def _lyrics_lines(
    x: np.ndarray,
    lyrics: str,
    heard: list[Heard],
    lang: str,
    aligner: AlignerBackend,
    chunks: Sequence[tuple[float, float]],
    duration: float,
    warnings: list[str],
) -> tuple[list[_Line], list[Run], list[Pair], list[dict[str, Any]], list[dict[str, Any]]]:
    parsed = parse_lyrics(lyrics)
    warnings.extend(parsed.warnings)
    lines: list[_Line] = []
    for ll in parsed.lines:
        units = tokenize(ll.text, lang)
        if units:
            lines.append(_Line(ll.text, units, ll))
    if not lines:
        warnings.append("the lyrics contain no singable text")
        return [], [], [], [], []
    lyric_keys: list[str] = []
    line_of_unit: list[int] = []
    for li, ln in enumerate(lines):
        for u in ln.units:
            lyric_keys.append(u.key)
            line_of_unit.append(li)
    heard_keys = [h.unit.key for h in heard]
    diffs: list[dict[str, Any]] = []
    adlib_items: list[dict[str, Any]] = []
    runs: list[Run] = []
    pairs: list[Pair] = []
    if heard:
        pairs = align_keys(lyric_keys, heard_keys)
        runs = find_runs(pairs, lyric_keys, heard_keys, line_of_unit)
    first_unit = {}
    for idx, li in enumerate(line_of_unit):
        first_unit.setdefault(li, idx)

    def unit_pos(idx: int) -> tuple[str, int]:
        li = line_of_unit[idx]
        return f"l{li + 1}", idx - first_unit[li] + 1

    not_sung: set[int] = set()
    for r in runs:
        if r.kind == "not_sung" and r.lyric:
            a, b = r.lyric
            not_sung.update(range(a, b))
            line_id, i0 = unit_pos(a)
            diffs.append(
                {
                    "type": "not_sung",
                    "line": line_id,
                    "i": i0,
                    "text": "".join(_unit_at(lines, line_of_unit, first_unit, k).text for k in range(a, b)),
                    "count": b - a,
                }
            )
        elif r.heard:
            a, b = r.heard
            hs = heard[a:b]
            units = [h.unit for h in hs]
            adlib_items.append(
                {
                    "kind": "repeat_unwritten" if r.kind == "repeat_unwritten" else "adlib",
                    "text": units_text(units),
                    "start": hs[0].start,
                    "end": hs[-1].end,
                    "units": units,
                    "spans": [(h.start, h.end) for h in hs],
                }
            )
            d: dict[str, Any] = {
                "type": r.kind,
                "text": units_text(units),
                "start": _r(hs[0].start),
                "end": _r(hs[-1].end),
            }
            if r.repeat_of:
                d["repeat_of_line"] = unit_pos(r.repeat_of[0])[0]
            diffs.append(d)
    agree_of: dict[int, float] = {}
    for p in pairs:
        if p.lyric is not None and p.heard is not None:
            agree_of[p.lyric] = 1.0 if p.exact else 0.5
            if not p.exact:
                line_id, i0 = unit_pos(p.lyric)
                diffs.append(
                    {
                        "type": "heard_differently",
                        "line": line_id,
                        "i": i0,
                        "lyric": _unit_at(lines, line_of_unit, first_unit, p.lyric).text,
                        "heard": heard[p.heard].unit.text,
                    }
                )
    # Windows ---------------------------------------------------------------------------------
    raw = _window_from_pairs(pairs, line_of_unit, heard, len(lines))
    if all(w is None for w in raw):
        warnings.append("no lyric line could be located from the recognised text; lines are spread evenly")
    span = (chunks[0][0], chunks[-1][1])
    lrc = [ln.lyric.lrc_time if ln.lyric else None for ln in lines]
    if all(w is None for w in raw) and all(t is not None for t in lrc):
        # Nothing was recognised, but every line carries a time: use those times as the windows.
        raw = [(lrc[i], lrc[i + 1] if i + 1 < len(lrc) else span[1]) for i in range(len(lrc))]  # type: ignore[misc]
    wins = _fill_windows(raw, [len(ln.units) for ln in lines], span)
    padded = _line_windows(wins, duration)
    pos = 0
    for li, ln in enumerate(lines):
        ln.window = padded[li]
        idxs = [pos + k for k in range(len(ln.units))]
        pos += len(ln.units)
        kept = [k for k, g in enumerate(idxs) if g not in not_sung]
        if not kept:
            ln.sung = False
            continue
        ln.kept = kept
        ln.agree = [agree_of.get(idxs[k], 0.2) for k in kept]
        a, b = ln.window
        spans = aligner.align(_slice(x, a, b), a, b, [ln.units[k] for k in kept], lang)
        ln.spans = [(float(s), float(e)) for s, e in spans]
        ln.mismatch = getattr(aligner, "last_mismatch", None)
    return lines, runs, pairs, diffs, adlib_items
