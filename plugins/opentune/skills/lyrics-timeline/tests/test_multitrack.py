# SPDX-License-Identifier: MIT
"""Tracks that sing only part of the lyrics, several tracks of one song, and singer marks."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import wave

import numpy as np
import pytest

from conftest import SR, synth_vocal
from lytl.backends import FakeAligner, FakeAsr, TruthToken
from lytl.lyrics import parse_lyrics
from lytl.pipeline import GAP_FILL_CONF_CAP, TrackInput, build_multitrack, build_timeline
from lytl.schema import validate_output

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
CLI = os.path.join(SCRIPTS, "lyrics_timeline.py")

UNIT, GAP = 0.35, 0.05
LINE_SEC = 7 * (UNIT + GAP) + 0.95  # one 7-character line plus the pause after it

EIGHT = ["春风吹过山岗上", "小河流向远方去", "我们一起来歌唱", "夜色慢慢地降临", "灯火照亮了街道", "梦里花开满园中", "明天依然很美好", "再见我亲爱朋友"]


def sung(lines: list[str], slots: list[int], start: float = 1.0) -> list[TruthToken]:
    """Truth for singing ``lines[i]`` at the time slot ``slots[i]`` of the song (one slot per line)."""
    out = []
    for text, slot in zip(lines, slots):
        t = start + slot * LINE_SEC
        for ch in text:
            out.append(TruthToken(ch, round(t, 3), round(t + UNIT, 3)))
            t += UNIT + GAP
    return out


def song_length(n_slots: int) -> float:
    return 1.0 + n_slots * LINE_SEC + 1.5


def track(truth: list[TruthToken], n_slots: int, label: str | None = None, name: str = "t.wav") -> TrackInput:
    return TrackInput(synth_vocal(truth, duration=song_length(n_slots)), name, SR, label)


def by_id(doc: dict) -> dict[str, dict]:
    return {ln["id"]: ln for ln in doc["lines"]}


# --- One track that sings part of the lyrics ---------------------------------------------------


def test_a_track_with_some_lines_marks_the_others_not_in_track_and_does_not_spread_them():
    picked = [1, 2, 5]  # lines 2, 3 and 6, each at its own place in the song
    truth = sung([EIGHT[i] for i in picked], picked)
    x = synth_vocal(truth, duration=song_length(8))
    doc = build_timeline(x, FakeAsr(truth), FakeAligner(truth), lyrics="\n".join(EIGHT))
    assert validate_output(doc) == []
    lines = by_id(doc)
    assert [lid for lid, ln in lines.items() if ln["sung"]] == ["l2", "l3", "l6"]
    for lid in ("l1", "l4", "l5", "l7", "l8"):
        assert lines[lid]["absent_reason"] == "not_in_track"
        assert lines[lid]["tokens"] == [] and lines[lid]["start"] is None
    # Lines 4 and 5 are not squeezed into the silence between lines 3 and 6, and nothing is guessed there.
    assert not any(w.startswith("line l4") or w.startswith("line l5") for w in doc["warnings"])
    assert lines["l6"]["start"] == pytest.approx(truth[14].start, abs=0.06)
    assert lines["l3"]["end"] == pytest.approx(truth[13].end, abs=0.06)
    assert not [d for d in doc["diffs"] if d["type"] == "not_sung"]  # whole absent lines are not "not sung" units
    assert doc["unmatched"] == []


def test_a_line_that_is_sung_but_not_recognised_between_two_found_lines_is_timed_with_low_confidence():
    truth = sung(EIGHT[:3], [0, 1, 2])
    x = synth_vocal(truth, duration=song_length(3))
    missed = set(EIGHT[1])  # the recogniser hears nothing of line 2
    doc = build_timeline(x, FakeAsr(truth, drop=missed), FakeAligner(truth), lyrics="\n".join(EIGHT[:3]))
    l2 = by_id(doc)["l2"]
    assert l2["sung"] and l2["absent_reason"] is None
    assert max(t["conf"] for t in l2["tokens"]) <= GAP_FILL_CONF_CAP
    assert l2["tokens"][0]["start"] == pytest.approx(truth[7].start, abs=0.1)
    assert any(w.startswith("line l2: not recognised on this track") for w in doc["warnings"])


def test_a_gap_without_singing_is_not_filled():
    truth = sung([EIGHT[0], EIGHT[2]], [0, 2])  # line 2 is not sung at all
    x = synth_vocal(truth, duration=song_length(3))
    doc = build_timeline(x, FakeAsr(truth), FakeAligner(truth), lyrics="\n".join(EIGHT[:3]))
    l2 = by_id(doc)["l2"]
    assert not l2["sung"] and l2["absent_reason"] == "not_in_track" and l2["tokens"] == []
    assert not any(w.startswith("line l2") for w in doc["warnings"])


CHORUS_SONG = """[Verse 1]
春风吹过山岗上
小河流向远方去
[Chorus]
我们一起来歌唱
明天依然很美好
[Verse 2]
夜色慢慢地降临
灯火照亮了街道
[Chorus]
"""
CHORUS = ["我们一起来歌唱", "明天依然很美好"]


def test_a_track_with_only_the_second_chorus_is_timed_on_the_second_chorus():
    truth = sung(CHORUS, [6, 7])
    doc = build_timeline(track(truth, 8).x, FakeAsr(truth), FakeAligner(truth), lyrics=CHORUS_SONG)
    lines = by_id(doc)
    assert [lid for lid, ln in lines.items() if ln["sung"]] == ["l7", "l8"]
    assert lines["l3"]["absent_reason"] == "not_in_track" and lines["l4"]["absent_reason"] == "not_in_track"
    assert lines["l7"]["start"] == pytest.approx(truth[0].start, abs=0.06)


def test_a_track_with_the_first_verse_and_chorus_keeps_the_chorus_on_the_first_occurrence():
    # Without a time prior the alignment pairs the chorus with whichever occurrence wins the tie.
    truth = sung(["春风吹过山岗上", "小河流向远方去", *CHORUS], [0, 1, 2, 3])
    doc = build_timeline(track(truth, 8).x, FakeAsr(truth), FakeAligner(truth), lyrics=CHORUS_SONG)
    lines = by_id(doc)
    assert [lid for lid, ln in lines.items() if ln["sung"]] == ["l1", "l2", "l3", "l4"]
    assert lines["l7"]["absent_reason"] == "not_in_track" and lines["l8"]["absent_reason"] == "not_in_track"
    assert lines["l3"]["start"] == pytest.approx(truth[14].start, abs=0.06)
    assert not [d for d in doc["diffs"] if d["type"] == "repeat_unwritten"]


def test_singing_that_matches_no_line_is_listed_as_unmatched():
    intro = [TruthToken(ch, round(1.0 + k * 0.4, 3), round(1.35 + k * 0.4, 3)) for k, ch in enumerate("大家好欢迎收听")]
    body = sung(EIGHT[:2], [2, 3])
    filler = [TruthToken("啊", round(body[-1].end + 4.0, 3), round(body[-1].end + 4.4, 3))]
    truth = intro + body + filler
    x = synth_vocal(truth, duration=filler[-1].end + 1.5)
    doc = build_timeline(x, FakeAsr(truth), FakeAligner(truth), lyrics="\n".join(EIGHT[:2]))
    assert doc["unmatched"] == [{"start": pytest.approx(1.0, abs=0.06), "end": pytest.approx(intro[-1].end, abs=0.06), "heard_text": "大家好欢迎收听"}]
    assert all(ln["sung"] for ln in doc["lines"])
    assert [a["text"] for a in doc["adlibs"]] == ["啊"]  # a lone filler stays an ad-lib
    assert validate_output(doc) == []


def test_single_track_output_keeps_its_shape_and_adds_fields():
    truth = sung(EIGHT[:2], [0, 1])
    doc = build_timeline(synth_vocal(truth), FakeAsr(truth), FakeAligner(truth), lyrics="\n".join(EIGHT[:2]))
    assert doc["mode"] == "lyrics" and doc["label"] is None and doc["language_source"] == "lyrics"
    assert doc["unmatched"] == []
    assert all(ln["absent_reason"] is None and ln["singers"] == [] for ln in doc["lines"])
    for key in ("sections", "lines", "breaths", "adlibs", "diffs", "suspects", "warnings", "confidence", "audio"):
        assert key in doc
    assert validate_output(doc) == []


# --- Several tracks ----------------------------------------------------------------------------

DUET = """[Verse 1]
{A}
春风吹过山岗上
小河流向远方去
[Chorus]
{all}
我们一起来歌唱
明天依然很美好
[Verse 2]
{B}
夜色慢慢地降临
灯火照亮了街道
[Chorus]
"""


def duet_tracks() -> tuple[list[list[TruthToken]], list[TrackInput]]:
    a = sung(["春风吹过山岗上", "小河流向远方去", *CHORUS, *CHORUS], [0, 1, 2, 3, 6, 7])
    b = sung([*CHORUS, "夜色慢慢地降临", "灯火照亮了街道", *CHORUS], [2, 3, 4, 5, 6, 7])
    harmony = sung([*CHORUS, *CHORUS], [2, 3, 6, 7])
    truths = [a, b, harmony]
    names = [("lead-a.wav", "A"), ("lead-b.wav", "B"), ("harmony.wav", "harmony")]
    return truths, [track(t, 8, label, name) for t, (name, label) in zip(truths, names)]


def test_two_leads_and_a_chorus_harmony_say_who_sings_each_line():
    truths, inputs = duet_tracks()
    doc = build_multitrack(inputs, FakeAsr(truths[0], tracks=truths), FakeAligner(truths[0], tracks=truths), lyrics=DUET)
    assert validate_output(doc) == []
    assert doc["mode"] == "multi_track" and doc["language"] == "zh"
    assert [(t["track"], t["label"], t["audio"]["name"]) for t in doc["tracks"]] == [
        ("t1", "A", "lead-a.wav"), ("t2", "B", "lead-b.wav"), ("t3", "harmony", "harmony.wav")
    ]
    who = {ll["id"]: [s["track"] for s in ll["sung_by"]] for ll in doc["lyric_lines"]}
    assert who == {
        "l1": ["t1"], "l2": ["t1"], "l3": ["t1", "t2", "t3"], "l4": ["t1", "t2", "t3"],
        "l5": ["t2"], "l6": ["t2"], "l7": ["t1", "t2", "t3"], "l8": ["t1", "t2", "t3"],
    }
    assert [ll["singers"] for ll in doc["lyric_lines"]] == [["A"], ["A"], ["all"], ["all"], ["B"], ["B"], ["all"], ["all"]]
    # The harmony's chorus lines are on their own occurrence, with the times of that track.
    l7 = next(ll for ll in doc["lyric_lines"] if ll["id"] == "l7")
    t3 = next(s for s in l7["sung_by"] if s["track"] == "t3")
    assert t3["start"] == pytest.approx(truths[2][14].start, abs=0.06) and t3["line"] == "l7"
    harmony = doc["tracks"][2]
    assert {ln["id"]: ln["absent_reason"] for ln in harmony["lines"] if not ln["sung"]} == {
        "l1": "not_in_track", "l2": "not_in_track", "l5": "not_in_track", "l6": "not_in_track"
    }
    assert any("'harmony' appears in no singer mark" in w for w in doc["warnings"])
    assert not any(d["type"] == "singer_mismatch" for t in doc["tracks"] for d in t["diffs"])


def test_a_harmony_with_only_the_first_chorus_uses_the_other_tracks_for_its_place():
    # A long intro: spreading the lyrics over the file would put the harmony's chorus nearer the
    # second occurrence. The lead tracks know where each chorus is; the harmony uses their times.
    intro = 30.0
    a = sung(["春风吹过山岗上", "小河流向远方去", *CHORUS, *CHORUS], [0, 1, 2, 3, 6, 7], start=intro)
    b = sung([*CHORUS, "夜色慢慢地降临", "灯火照亮了街道", *CHORUS], [2, 3, 4, 5, 6, 7], start=intro)
    harmony = sung(CHORUS, [2, 3], start=intro)
    truths = [a, b, harmony]
    inputs = [TrackInput(synth_vocal(t, duration=song_length(8) + intro), f"t{k}.wav", SR, None) for k, t in enumerate(truths)]
    doc = build_multitrack(inputs, FakeAsr(a, tracks=truths), FakeAligner(a, tracks=truths), lyrics=DUET)
    who = {ll["id"]: [s["track"] for s in ll["sung_by"]] for ll in doc["lyric_lines"]}
    assert who["l3"] == ["t1", "t2", "t3"] and who["l7"] == ["t1", "t2"]
    # On its own the file has no better clue than the lyrics spread over its length (a documented limit).
    alone = build_timeline(inputs[2].x, FakeAsr(harmony), FakeAligner(harmony), lyrics=DUET)
    assert by_id(alone)["l7"]["sung"] and not by_id(alone)["l3"]["sung"]


def test_singer_marks_are_parsed():
    p = parse_lyrics("{A} line one\n{A, B} line two\n{ALL}\nline three\nline four\n{}\nline five\n｛甲／乙｝line six")
    assert [ln.singers for ln in p.lines] == [("A",), ("A", "B"), ("all",), ("all",), (), ("甲", "乙")]
    assert [ln.text for ln in p.lines] == ["line one", "line two", "line three", "line four", "line five", "line six"]


def test_a_track_that_sings_a_line_marked_for_someone_else_gets_a_singer_mismatch():
    lyrics = "{A}\n春风吹过山岗上\n小河流向远方去\n{B}\n我们一起来歌唱\n明天依然很美好"
    truth = sung(["春风吹过山岗上", "我们一起来歌唱", "明天依然很美好"], [0, 2, 3])  # A skips line 2, sings B's lines
    doc = build_timeline(track(truth, 4).x, FakeAsr(truth), FakeAligner(truth), lyrics=lyrics, label="a")
    mism = {d["line"]: d for d in doc["diffs"] if d["type"] == "singer_mismatch"}
    assert mism["l2"] == {"type": "singer_mismatch", "line": "l2", "marked": ["A"], "label": "a", "heard": False}
    assert mism["l3"]["heard"] is True and mism["l3"]["marked"] == ["B"] and set(mism) == {"l2", "l3", "l4"}
    assert by_id(doc)["l3"]["sung"]  # the audio decides; the mark only raises the bar
    # Without a label the marks are not compared.
    doc = build_timeline(track(truth, 4).x, FakeAsr(truth), FakeAligner(truth), lyrics=lyrics)
    assert not [d for d in doc["diffs"] if d["type"] == "singer_mismatch"]


def test_a_line_marked_for_another_singer_needs_more_evidence():
    lyrics = "{A}\n春风吹过山岗上\n{B}\n小河流向远方去"
    # Track A carries four characters of B's line (bleed from the other singer), not the line.
    stray = [TruthToken(ch, round(6.0 + k * 0.4, 3), round(6.35 + k * 0.4, 3)) for k, ch in enumerate("向远方去")]
    truth = sung(["春风吹过山岗上"], [0]) + stray
    x = synth_vocal(truth, duration=10.0)
    with_label = build_timeline(x, FakeAsr(truth), FakeAligner(truth), lyrics=lyrics, label="A")
    without = build_timeline(x, FakeAsr(truth), FakeAligner(truth), lyrics=lyrics)
    assert not by_id(with_label)["l2"]["sung"]  # 4 of 7 keys: not enough for a line marked for B (3/4)
    assert by_id(without)["l2"]["sung"]  # but enough for a line nobody is named for (half)


@pytest.mark.parametrize("heard, on_track", [("方去", False), ("远方去", False), ("向远方去", True)])
def test_a_line_is_on_the_track_when_half_of_its_sounds_are_heard_exactly(heard, on_track):
    stray = [TruthToken(ch, round(6.0 + k * 0.4, 3), round(6.35 + k * 0.4, 3)) for k, ch in enumerate(heard)]
    truth = sung(["春风吹过山岗上"], [0]) + stray
    doc = build_timeline(synth_vocal(truth, duration=10.0), FakeAsr(truth), FakeAligner(truth), lyrics="春风吹过山岗上\n小河流向远方去")
    assert by_id(doc)["l2"]["sung"] is on_track
    assert by_id(doc)["l2"]["absent_reason"] == (None if on_track else "not_in_track")


@pytest.mark.parametrize("heard, on_track", [("家", False), ("回家", True)])
def test_a_two_character_line_needs_both_heard(heard, on_track):
    stray = [TruthToken(ch, round(6.0 + k * 0.4, 3), round(6.35 + k * 0.4, 3)) for k, ch in enumerate(heard)]
    truth = sung(["春风吹过山岗上"], [0]) + stray
    doc = build_timeline(synth_vocal(truth, duration=10.0), FakeAsr(truth), FakeAligner(truth), lyrics="春风吹过山岗上\n回家")
    assert by_id(doc)["l2"]["sung"] is on_track


def test_a_vocalise_where_lines_were_is_not_taken_for_those_lines():
    # Lines 2 and 3, then "la la ..." where line 4 would be, then line 6. The alignment pairs the
    # "la"s with line 4 (a mismatch costs less than two gaps); none of them is an exact match.
    truth = sung([EIGHT[1], EIGHT[2], "啦啦啦啦啦", EIGHT[5]], [1, 2, 3, 5])
    x = synth_vocal(truth, duration=song_length(8))
    doc = build_timeline(x, FakeAsr(truth), FakeAligner(truth), lyrics="\n".join(EIGHT))
    lines = by_id(doc)
    assert [lid for lid, ln in lines.items() if ln["sung"]] == ["l2", "l3", "l6"]
    assert lines["l4"]["absent_reason"] == "not_in_track"
    assert [a["text"] for a in doc["adlibs"]] == ["啦啦啦啦啦"] and doc["unmatched"] == []


# --- Command line ------------------------------------------------------------------------------


def _wav(path, x: np.ndarray) -> str:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return str(path)


def _cli(*args: str) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PLUGIN_DATA", "OPENTUNE_LYRICS_HOME")}
    return subprocess.run(
        [sys.executable, "-I", CLI, *args], capture_output=True, text=True, encoding="utf-8", env=env, check=False
    )


def test_cli_with_several_tracks_and_labels(tmp_path):
    truths, inputs = duet_tracks()
    wavs = [_wav(tmp_path / inp.audio_name, inp.x) for inp in inputs[:2]]
    fake = tmp_path / "truth.json"
    fake.write_text(
        json.dumps({"tracks": [[{"text": t.text, "start": t.start, "end": t.end} for t in tr] for tr in truths[:2]]}, ensure_ascii=False),
        encoding="utf-8",
    )
    lyr = tmp_path / "lyrics.txt"
    lyr.write_text(DUET, encoding="utf-8")
    out = tmp_path / "out.json"
    r = _cli(*wavs, "--lyrics-file", str(lyr), "--track-label", "lead-a.wav=A", "--track-label", f"{wavs[1]}=B",
             "--backend", "fake", "--fake-truth", str(fake), "--out", str(out))
    assert r.returncode == 0, r.stderr
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert validate_output(doc) == [] and "2 tracks, 8 lyric lines" in r.stderr
    assert [t["label"] for t in doc["tracks"]] == ["A", "B"]
    assert [s["track"] for s in doc["lyric_lines"][4]["sung_by"]] == ["t2"]

    r = _cli(*wavs, "--notes", str(fake), "--backend", "fake", "--fake-truth", str(fake))
    assert r.returncode == 2 and "--notes works with one audio file" in r.stderr
    r = _cli(*wavs, "--track-label", "nope.wav=A", "--backend", "fake", "--fake-truth", str(fake))
    assert r.returncode != 0 and "matches no audio file" in r.stderr


def test_cli_rejects_an_unsupported_language_before_loading_models(tmp_path):
    wav = _wav(tmp_path / "v.wav", np.zeros(SR, dtype=np.float32))
    # The real back end is selected; the error must come before it looks for any model.
    r = _cli(wav, "--lyrics-text", "สวัสดีครับ", "--language", "auto")
    assert r.returncode != 0 and "Thai (th) can be recognised" in r.stderr and "setup.py" not in r.stderr
    r = _cli(wav, "--language", "vi")
    assert r.returncode != 0 and "supported languages: zh (Chinese)" in r.stderr
