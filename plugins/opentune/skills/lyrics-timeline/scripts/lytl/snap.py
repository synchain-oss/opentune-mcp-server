# SPDX-License-Identifier: MIT
"""Snap token starts to note starts and acoustic onsets; split long tokens by notes."""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from typing import Any, Iterable

DEFAULT_SNAP_WINDOW = 0.09  # seconds either side
MIN_NOTE_OVERLAP = 0.02


@dataclass
class Note:
    index: int | None
    start: float
    end: float
    midi: float | None = None


def _first(d: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


def parse_notes(data: Any) -> list[Note]:
    """Accept the result of ``opentune_get_notes`` (content clock) in any of its usual wrappings."""
    if isinstance(data, dict):
        for key in ("notes", "items", "result", "structuredContent", "data"):
            if key in data:
                return parse_notes(data[key])
        return []
    if not isinstance(data, list):
        return []
    notes: list[Note] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        start = _first(item, "startContentSec", "start_content_sec", "start_sec", "start")
        end = _first(item, "endContentSec", "end_content_sec", "end_sec", "end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
            continue
        idx = _first(item, "index", "note", "id")
        midi = _first(item, "detectedMidi", "detected_midi", "targetMidi", "target_midi", "midi")
        notes.append(
            Note(
                idx if isinstance(idx, int) else None,
                float(start),
                float(end),
                float(midi) if isinstance(midi, (int, float)) else None,
            )
        )
    notes.sort(key=lambda n: (n.start, n.end))
    return notes


def _nearest(sorted_times: list[float], t: float, window: float) -> float | None:
    i = bisect.bisect_left(sorted_times, t)
    best = None
    for k in (i - 1, i):
        if 0 <= k < len(sorted_times) and abs(sorted_times[k] - t) <= window:
            if best is None or abs(sorted_times[k] - t) < abs(best - t):
                best = sorted_times[k]
    return best


def snap_start(
    t: float,
    onsets: list[float],
    note_starts: list[float],
    window: float = DEFAULT_SNAP_WINDOW,
) -> tuple[float, str | None]:
    """A note start inside the window wins, else the nearest acoustic onset, else no change."""
    n = _nearest(note_starts, t, window)
    if n is not None:
        return n, "note"
    o = _nearest(onsets, t, window)
    if o is not None:
        return o, "onset"
    return t, None


def split_by_notes(start: float, end: float, notes: Iterable[Note]) -> list[dict[str, Any]]:
    """The part of [start, end] covered by each note, clipped to the token."""
    out: list[dict[str, Any]] = []
    for note in notes:
        a, b = max(start, note.start), min(end, note.end)
        if b - a >= MIN_NOTE_OVERLAP:
            out.append({"note_index": note.index, "start": round(a, 4), "end": round(b, 4)})
    return out


def enforce_order(spans: list[list[float]], min_len: float = 0.01) -> None:
    """In place: starts increase by at least ``min_len``, each end is after its start and not past the next start."""
    for i, sp in enumerate(spans):
        if i > 0 and sp[0] < spans[i - 1][0] + min_len:
            sp[0] = spans[i - 1][0] + min_len
        if sp[1] < sp[0] + min_len:
            sp[1] = sp[0] + min_len
    for i in range(len(spans) - 1):
        if spans[i][1] > spans[i + 1][0] and spans[i + 1][0] >= spans[i][0] + min_len:
            spans[i][1] = spans[i + 1][0]
