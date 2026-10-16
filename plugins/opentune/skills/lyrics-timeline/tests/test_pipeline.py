# SPDX-License-Identifier: MIT
from __future__ import annotations

import json

import pytest

from conftest import LYRICS, SONG, build_truth, synth_vocal
from lytl.backends import FakeAligner, FakeAsr, TruthToken
from lytl.pipeline import build_timeline
from lytl.schema import validate_output
from lytl.snap import Note


def _line_with(doc, text):
    return next(ln for ln in doc["lines"] if ln["text"] == text)


def test_given_lyrics_full_structure(vocal, backends, truth):
    asr, aligner = backends
    doc = build_timeline(vocal, asr, aligner, lyrics=LYRICS, language="zh", audio_name="take1.wav")
    assert validate_output(doc) == []
    assert doc["mode"] == "lyrics" and "needs_confirmation" not in doc
    assert doc["audio"]["name"] == "take1.wav" and doc["language"] == "zh"
    assert [ln["text"] for ln in doc["lines"]] == SONG
    labels = [(s["label"], s["occurrence"], s["source"]) for s in doc["sections"]]
    assert labels == [("verse", 1, "user"), ("chorus", 1, "user"), ("verse", 2, "user"), ("chorus", 2, "user")]
    assert doc["diffs"] == [] and doc["adlibs"] == []


def test_find_the_deep_in_the_first_chorus_line(vocal, backends, truth):
    asr, aligner = backends
    doc = build_timeline(vocal, asr, aligner, lyrics=LYRICS, language="zh")
    chorus = next(s for s in doc["sections"] if s["label"] == "chorus" and s["occurrence"] == 1)
    line = next(ln for ln in doc["lines"] if ln["id"] == chorus["lines"][0])
    assert line["line_in_section"] == 1 and line["text"] == "我爱你有多深"
    token = line["tokens"][-1]
    assert token["text"] == "深" and token["i"] == 6
    # Ground truth: the sixth character of the third SONG line.
    idx = sum(len(s) for s in SONG[:2]) + 5
    assert token["start"] == pytest.approx(truth[idx].start, abs=0.06)
    assert token["end"] == pytest.approx(truth[idx].end, abs=0.08)


def test_all_token_times_are_close_to_the_script(vocal, backends, truth):
    asr, aligner = backends
    doc = build_timeline(vocal, asr, aligner, lyrics=LYRICS, language="zh")
    got = [t for ln in doc["lines"] for t in ln["tokens"]]
    assert len(got) == len(truth)
    assert max(abs(g["start"] - t.start) for g, t in zip(got, truth)) < 0.06
    assert all(g["voiced_start"] >= g["start"] for g in got)
    assert all(0 <= g["conf"] <= 1 for g in got)


def test_note_starts_are_preferred_and_long_tokens_are_split(vocal, truth):
    notes = [Note(0, truth[0].start + 0.04, truth[0].start + 0.2), Note(1, truth[0].start + 0.2, truth[0].end)]
    shifted = FakeAligner(truth, noise=0.07)  # every start is 70 ms late; the note start is 30 ms before it
    doc = build_timeline(vocal, FakeAsr(truth), shifted, lyrics=SONG[0], language="zh", notes=notes)
    first = doc["lines"][0]["tokens"][0]
    assert first["snap"]["source"] == "note"
    assert first["start"] == pytest.approx(truth[0].start + 0.04, abs=0.002)
    assert [n["note_index"] for n in first["notes"]] == [0, 1]
    assert doc["params"]["notes_given"] == 2


def test_without_lyrics_text_is_never_rewritten(vocal, truth):
    asr = FakeAsr(truth, substitutions={"深": "的"})  # a wrong but plausible hearing
    doc = build_timeline(vocal, asr, FakeAligner(truth), lyrics=None, language="zh")
    assert validate_output(doc) == []
    assert doc["mode"] == "asr_only" and doc["needs_confirmation"] is True
    heard = "".join(t["text"] for ln in doc["lines"] for t in ln["tokens"])
    assert heard == "".join(s.replace("深", "的") for s in SONG)
    suspects = [s for s in doc["suspects"] if s["reason"] == "homophone"]
    wrong = next(s for s in suspects if s["line"] == "l3")
    assert (wrong["i"], wrong["text"]) == (6, "的") and "得" in wrong["alternatives"]
    assert all(s["alternatives"] for s in suspects)
    # Chorus lines repeat, so sections are inferred even though nobody wrote tags.
    assert any(s["label"] == "chorus" and s["source"] == "inferred" for s in doc["sections"])


def test_unsung_lyric_adlib_and_misheard_are_reported(vocal, truth):
    lyrics = LYRICS.replace("我想起你的模样", "我想起你的好模样")  # '好' is written but not sung
    adlib_truth = list(truth)
    # '啊' sung after the second line (a gap of 1 s is free there).
    after = truth[13].end + 0.12
    adlib_truth.insert(14, TruthToken("啊", after, after + 0.3))
    x = synth_vocal(sorted(adlib_truth, key=lambda t: t.start))
    # A homophone such as 悦 would compare equal by design, so use a different sound.
    asr = FakeAsr(adlib_truth, substitutions={"月": "日"})
    doc = build_timeline(x, asr, FakeAligner(adlib_truth), lyrics=lyrics, language="zh")
    assert validate_output(doc) == []
    kinds = {d["type"] for d in doc["diffs"]}
    assert {"not_sung", "adlib", "heard_differently"} <= kinds
    not_sung = next(d for d in doc["diffs"] if d["type"] == "not_sung")
    assert not_sung["text"] == "好" and not_sung["line"] == "l2"
    line2 = doc["lines"][1]
    assert [t["text"] for t in line2["tokens"] if t["i"] is not None] == list("我想起你的模样")
    assert [t["i"] for t in line2["tokens"] if t["i"] is not None] == list(range(1, 8))  # ad-libs add no index
    assert any(a["text"] == "啊" for a in doc["adlibs"])


def test_unsung_line_has_no_times(vocal, truth):
    lyrics = LYRICS.replace("星光照亮回家路", "星光照亮回家路\n这一句没有唱")
    doc = build_timeline(vocal, FakeAsr(truth), FakeAligner(truth), lyrics=lyrics, language="zh")
    line = _line_with(doc, "这一句没有唱")
    assert line["sung"] is False and line["start"] is None and line["tokens"] == []
    assert validate_output(doc) == []


def test_english_words_and_backing_text(vocal):
    words = "I love you more than words can say".split()
    truth = []
    t = 1.0
    for w in words:
        truth.append(TruthToken(w, t, t + 0.4))
        t += 0.5
    x = synth_vocal(truth)
    doc = build_timeline(x, FakeAsr(truth), FakeAligner(truth), lyrics="I love you more (oh)\nthan words can say", language="en")
    assert [t["text"] for ln in doc["lines"] for t in ln["tokens"]] == [w.lower() for w in words]
    assert all(t["type"] == "word" for ln in doc["lines"] for t in ln["tokens"])
    assert any(d["type"] == "backing_unaligned" and d["text"] == "oh" for d in doc["diffs"])


def test_silence_gives_an_empty_document():
    import numpy as np

    doc = build_timeline(np.zeros(32000, np.float32), FakeAsr([]), FakeAligner([]), lyrics="x", language="zh")
    assert doc["lines"] == [] and doc["warnings"]
    assert validate_output(doc) == []


def test_output_is_json_serialisable_and_stable(vocal, backends):
    asr, aligner = backends
    a = build_timeline(vocal, asr, aligner, lyrics=LYRICS, language="zh")
    b = build_timeline(vocal, asr, aligner, lyrics=LYRICS, language="zh")
    assert json.dumps(a, ensure_ascii=False) == json.dumps(b, ensure_ascii=False)
    assert set(a) >= {"sections", "lines", "breaths", "adlibs", "diffs", "models", "params", "confidence", "version"}


def test_validator_catches_a_broken_document(vocal, backends):
    asr, aligner = backends
    doc = build_timeline(vocal, asr, aligner, lyrics=LYRICS, language="zh")
    doc["lines"][0]["tokens"][0]["end"] = doc["lines"][0]["tokens"][0]["start"] - 1
    assert validate_output(doc)
    del doc["sections"]
    assert any("sections" in e for e in validate_output(doc))
