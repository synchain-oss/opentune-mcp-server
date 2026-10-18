# SPDX-License-Identifier: MIT
from __future__ import annotations

import numpy as np
import pytest

from conftest import SR, SONG
from lytl import audio, snap


def test_frame_features_find_pitch_and_silence(vocal, truth):
    f = audio.frame_features(vocal)
    first = truth[0]
    mid = f.frame_at((first.start + first.end) / 2)
    assert f.voiced[mid] and abs(f.f0[mid] - 200.0) < 8.0
    assert not f.voiced[f.frame_at(0.5)]


def test_vad_returns_one_region_per_line(vocal):
    regions = audio.energy_vad(audio.frame_features(vocal))
    assert len(regions) == len(SONG)
    assert regions[0][0] == pytest.approx(1.0, abs=0.06)


def test_chunks_never_exceed_the_asr_limit():
    # One unbroken 70 s tone must be cut at quiet points into pieces of at most 30 s.
    t = np.arange(70 * SR) / SR
    x = (0.2 * np.sin(2 * np.pi * 220 * t) * (1 + 0.5 * np.sin(2 * np.pi * 0.2 * t))).astype(np.float32)
    f = audio.frame_features(x)
    chunks = audio.split_chunks([(0.0, 70.0)], f)
    assert all(b - a <= audio.MAX_ASR_SEC + 1e-6 for a, b in chunks)
    assert chunks[0][0] == 0.0 and chunks[-1][1] == pytest.approx(70.0)
    assert all(chunks[i][1] == pytest.approx(chunks[i + 1][0]) for i in range(len(chunks) - 1))


def test_alignment_windows_stay_under_280_seconds():
    chunks = [(i * 30.0, i * 30.0 + 29.0) for i in range(20)]
    groups = audio.group_windows(chunks)
    assert sum(len(g) for g in groups) == 20
    assert all(chunks[g[-1]][1] - chunks[g[0]][0] <= audio.MAX_ALIGN_SEC for g in groups)


def test_onsets_sit_at_token_starts(vocal, truth):
    onsets = audio.detect_onsets(audio.frame_features(vocal))
    firsts = [t.start for t in truth[:7]]
    for s in firsts:
        assert min(abs(o - s) for o in onsets) < 0.04


def test_voiced_start_and_ratio(vocal, truth):
    f = audio.frame_features(vocal)
    tok = truth[0]
    assert audio.voiced_start(tok.start - 0.1, tok.end, f) >= tok.start - 0.02
    assert audio.voiced_ratio(tok.start + 0.05, tok.end - 0.05, f) > 0.8


def test_breath_between_lines():
    n = int(6 * SR)
    rng = np.random.default_rng(3)
    x = rng.normal(0, 0.0005, n).astype(np.float32)
    t = np.arange(n) / SR
    for a, b in ((0.5, 2.0), (4.0, 5.5)):
        s = slice(int(a * SR), int(b * SR))
        x[s] += 0.3 * np.sin(2 * np.pi * 220 * t[s]).astype(np.float32)
    s = slice(int(2.8 * SR), int(3.3 * SR))  # a quiet hiss, well below the singing
    x[s] += rng.normal(0, 0.004, s.stop - s.start).astype(np.float32)
    f = audio.frame_features(x)
    breaths = audio.detect_breaths(f, audio.energy_vad(f))
    assert len(breaths) == 1 and breaths[0][0] == pytest.approx(2.8, abs=0.1)


def test_resample_fallback_length(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_scipy(name, *a, **k):
        if name.startswith("scipy"):
            raise ImportError(name)
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", no_scipy)
    y = audio.resample(np.zeros(48000, np.float32), 48000, 16000)
    assert y.size == 16000


# --- snapping -------------------------------------------------------------------------------


def test_note_start_beats_onset_inside_the_window():
    assert snap.snap_start(1.00, [1.03], [1.06], 0.09) == (1.06, "note")


def test_onset_is_used_without_a_note_and_window_is_respected():
    assert snap.snap_start(1.00, [1.05], [], 0.09) == (1.05, "onset")
    assert snap.snap_start(1.00, [1.2], [1.3], 0.09) == (1.0, None)


def test_split_long_token_by_notes():
    notes = [snap.Note(4, 1.0, 1.5), snap.Note(5, 1.5, 2.2), snap.Note(6, 2.2, 3.0)]
    parts = snap.split_by_notes(1.2, 2.4, notes)
    assert [(p["note_index"], p["start"], p["end"]) for p in parts] == [(4, 1.2, 1.5), (5, 1.5, 2.2), (6, 2.2, 2.4)]
    assert snap.split_by_notes(5.0, 6.0, notes) == []


def test_enforce_order():
    spans = [[1.0, 1.4], [0.9, 1.0], [1.3, 1.31]]
    snap.enforce_order(spans)
    assert [s[0] for s in spans] == sorted(s[0] for s in spans)
    assert all(s[1] > s[0] for s in spans)
    assert spans[0][1] <= spans[1][0] + 1e-9


def test_parse_notes_accepts_common_wrappings():
    note = {"index": 3, "startContentSec": 1.0, "endContentSec": 2.0, "detectedMidi": 60.2}
    for doc in ([note], {"notes": [note]}, {"structuredContent": {"notes": [note]}}):
        got = snap.parse_notes(doc)
        assert len(got) == 1 and got[0].index == 3 and got[0].midi == pytest.approx(60.2)
    assert snap.parse_notes({"notes": [{"index": 1, "startContentSec": 2.0, "endContentSec": 1.0}]}) == []
