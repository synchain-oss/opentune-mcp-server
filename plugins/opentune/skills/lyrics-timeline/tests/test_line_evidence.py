# SPDX-License-Identifier: MIT
"""Lines the recogniser heard badly, echo lines, the second look, and checks across tracks."""

from __future__ import annotations

import copy

import pytest

from conftest import SR, synth_vocal
from lytl.backends import FakeAligner, FakeAsr, TruthToken
from lytl.normalize import tokenize
from lytl.pipeline import (
    APPROX_CONF_CAP,
    GAP_FILL_CONF_CAP,
    SECOND_PASS_CONF_HIGH,
    SECOND_PASS_CONF_LOW,
    Heard,
    TrackInput,
    _clusters,
    _Decision,
    _keep_in_chunks,
    _second_cap,
    _spread_zero_spans,
    _without_filler_stretches,
    build_multitrack,
    build_timeline,
)
from lytl.schema import validate_output
from lytl.seqalign import align_within
from lytl.snap import Note
from test_multitrack import EIGHT, LINE_SEC, by_id, song_length, sung, track

FOUR = EIGHT[:4]
# The recogniser hears only the last two characters of lines 2 and 3 (none of these is in lines 1 or 4).
BARELY = set("小河流向远") | set("我们一起来")


def warned(doc: dict, prefix: str) -> list[str]:
    return [w for w in doc["warnings"] if w.startswith(prefix)]


def who(doc: dict) -> dict[str, list[str]]:
    return {ll["id"]: [s["track"] for s in ll["sung_by"]] for ll in doc["lyric_lines"]}


# --- Lines not recognised on one track ---------------------------------------------------------


def test_one_track_times_two_badly_recognised_lines_in_a_row_with_low_confidence():
    truth = sung(FOUR, [0, 1, 2, 3])
    doc = build_timeline(track(truth, 4).x, FakeAsr(truth, drop=BARELY), FakeAligner(truth), lyrics="\n".join(FOUR))
    assert validate_output(doc) == []
    lines = by_id(doc)
    for lid, first in (("l2", 7), ("l3", 14)):
        ln = lines[lid]
        assert ln["sung"] and ln["absent_reason"] is None
        assert max(t["conf"] for t in ln["tokens"]) <= GAP_FILL_CONF_CAP < 0.5
        assert ln["start"] == pytest.approx(truth[first].start, abs=0.15)
        assert ln["end"] == pytest.approx(truth[first + 6].end, abs=0.15)
        assert any("shared with the other lines of that gap" in w for w in warned(doc, f"line {lid}: not recognised on this track"))


def test_other_words_between_two_lines_are_not_taken_for_the_lines_missing_there():
    talk = "大家好欢迎收听" * 2  # shares no sound with lines 2 and 3
    start = 1.0 + LINE_SEC
    words = [TruthToken(ch, round(start + k * 0.4, 3), round(start + k * 0.4 + 0.35, 3)) for k, ch in enumerate(talk)]
    truth = sung([FOUR[0]], [0]) + words + sung([FOUR[3]], [3])
    doc = build_timeline(track(truth, 4).x, FakeAsr(truth), FakeAligner(truth), lyrics="\n".join(FOUR))
    lines = by_id(doc)
    assert [(lines[k]["sung"], lines[k]["absent_reason"]) for k in ("l2", "l3")] == [(False, "not_in_track")] * 2
    assert [u["heard_text"] for u in doc["unmatched"]] == [talk]


def test_one_track_whose_label_is_in_the_singer_marks_does_not_guess_several_lines():
    lyrics = "{A}\n" + "\n".join(FOUR)
    truth = sung(FOUR, [0, 1, 2, 3])
    doc = build_timeline(track(truth, 4).x, FakeAsr(truth, drop=BARELY), FakeAligner(truth), lyrics=lyrics, label="A")
    lines = by_id(doc)
    assert [(lines[k]["sung"], lines[k]["absent_reason"]) for k in ("l2", "l3")] == [(False, "not_recognised")] * 2


def test_several_tracks_do_not_guess_several_lines_but_flag_them_as_not_recognised():
    lyrics = "\n".join([*FOUR, EIGHT[4]])
    lead = sung(FOUR, [0, 1, 2, 3])
    other = sung([EIGHT[4]], [4])
    truths = [lead, other]
    inputs = [track(t, 5, name=f"t{k}.wav") for k, t in enumerate(truths)]
    doc = build_multitrack(inputs, FakeAsr(lead, drop=BARELY, tracks=truths), FakeAligner(lead, tracks=truths), lyrics=lyrics)
    assert validate_output(doc) == []
    lines = by_id(doc["tracks"][0])
    assert [(lines[k]["sung"], lines[k]["absent_reason"]) for k in ("l2", "l3")] == [(False, "not_recognised")] * 2
    assert not warned(doc["tracks"][0], "line l2: not recognised on this track")


@pytest.mark.parametrize(
    "case, reason",
    [
        ("heard two characters of it", "not_recognised"),
        ("heard nothing of it", "not_recognised"),
        ("silence", "not_in_track"),
        ("other words", "not_in_track"),
    ],
)
def test_a_line_without_times_says_why(case, reason):
    # Line 1 comes before the first line found on the track, so it is never filled in.
    body = sung(EIGHT[1:3], [1, 2])
    drop: set[str] = set()
    if case == "silence":
        truth = body
    elif case == "other words":  # seven words that share one sound (春) with line 1 by chance
        truth = [TruthToken(ch, round(1.0 + k * 0.4, 3), round(1.35 + k * 0.4, 3)) for k, ch in enumerate("大家好欢迎春天")] + body
    else:
        truth = sung([EIGHT[0]], [0]) + body
        drop = set("春风吹过山") if case == "heard two characters of it" else set(EIGHT[0])
    doc = build_timeline(track(truth, 3).x, FakeAsr(truth, drop=drop), FakeAligner(truth), lyrics="\n".join(EIGHT[:3]))
    l1 = by_id(doc)["l1"]
    assert not l1["sung"] and l1["absent_reason"] == reason
    assert validate_output(doc) == []


def test_next_to_a_track_that_sings_the_line_singing_without_words_is_not_flagged():
    # The first track hums where the second sings line 1: humming is what stems are full of.
    hum = [TruthToken("嗯", round(1.0 + k * 0.4, 3), round(1.35 + k * 0.4, 3)) for k in range(7)]
    first = hum + sung(EIGHT[1:3], [1, 2])
    second = sung([EIGHT[0]], [0])
    truths = [first, second]
    inputs = [track(t, 3, name=f"t{k}.wav") for k, t in enumerate(truths)]
    doc = build_multitrack(inputs, FakeAsr(first, drop={"嗯"}, tracks=truths), FakeAligner(first, tracks=truths), lyrics="\n".join(EIGHT[:3]))
    assert by_id(doc["tracks"][0])["l1"]["absent_reason"] == "not_in_track"
    alone = build_timeline(inputs[0].x, FakeAsr(first, drop={"嗯"}), FakeAligner(first), lyrics="\n".join(EIGHT[:3]))
    assert by_id(alone)["l1"]["absent_reason"] == "not_recognised"  # on its own the track may be singing it


# --- Echo lines and the second look ------------------------------------------------------------


def test_an_echo_line_does_not_take_the_end_of_the_line_it_repeats():
    # The lyrics write the echo of a line's end as its own line; this track sings only the line.
    lyrics = "春风吹过山岗上\n山岗上\n小河流向远方去"
    truth = sung(["春风吹过山岗上", "小河流向远方去"], [0, 2])
    doc = build_timeline(track(truth, 3).x, FakeAsr(truth), FakeAligner(truth), lyrics=lyrics)
    lines = by_id(doc)
    assert lines["l1"]["sung"] and len(lines["l1"]["tokens"]) == 7
    assert lines["l1"]["end"] == pytest.approx(truth[6].end, abs=0.06)
    assert not lines["l2"]["sung"] and lines["l2"]["absent_reason"] == "not_in_track"


def test_an_echo_line_sung_on_its_own_is_kept():
    lyrics = "春风吹过山岗上\n山岗上\n小河流向远方去"
    truth = sung(["春风吹过山岗上", "山岗上", "小河流向远方去"], [0, 1, 2])
    doc = build_timeline(track(truth, 3).x, FakeAsr(truth), FakeAligner(truth), lyrics=lyrics)
    assert [ln["sung"] for ln in doc["lines"]] == [True, True, True]
    assert by_id(doc)["l2"]["start"] == pytest.approx(truth[7].start, abs=0.06)


def test_an_echo_line_sung_after_a_pause_keeps_its_sounds_when_the_end_of_the_line_was_missed():
    # Both lines are sung, but the recogniser missed the end of line 1 (山岗上). What it heard next
    # is the echo line, sung a second later: that is no tail of line 1 sung straight on.
    lyrics = "春风吹过山岗上\n山岗上\n小河流向远方去"
    sung_all = sung(["春风吹过山岗上", "山岗上", "小河流向远方去"], [0, 1, 2])
    heard = sung_all[:4] + sung_all[7:]
    doc = build_timeline(track(sung_all, 3).x, FakeAsr(heard), FakeAligner(heard), lyrics=lyrics)
    lines = by_id(doc)
    assert [ln["sung"] for ln in doc["lines"]] == [True, True, True]
    assert lines["l2"]["start"] == pytest.approx(sung_all[7].start, abs=0.06)
    assert [t["text"] for t in lines["l1"]["tokens"]] == list("春风吹过")
    assert lines["l1"]["end"] < sung_all[7].start
    assert [(d["line"], d["text"]) for d in doc["diffs"] if d["type"] == "not_sung"] == [("l1", "山岗上")]


def test_a_line_whose_end_starts_the_next_line_is_found_by_the_second_look():
    # The end of line 1 is the start of line 2 (not on this track), and one character of line 1 is
    # misheard. Giving the shared sounds to line 1 or to line 2 costs the same in the whole-song
    # alignment, which leaves line 1 with one exact sound of five.
    lyrics = "我在山岗上\n山岗上的风吹过来\n小河流向远方去"
    truth = sung(["我在山岗上"], [0])
    doc = build_timeline(track(truth, 3).x, FakeAsr(truth, substitutions={"我": "你"}), FakeAligner(truth), lyrics=lyrics)
    lines = by_id(doc)
    assert lines["l1"]["sung"] and not lines["l2"]["sung"]
    assert lines["l1"]["start"] == pytest.approx(truth[0].start, abs=0.06)
    # Five sounds: a short line, so the lowest cap, well under the 0.5 at which the model asks first.
    assert 0 < max(t["conf"] for t in lines["l1"]["tokens"]) <= SECOND_PASS_CONF_LOW < 0.5
    assert warned(doc, "line l1: found only by a second, line-by-line comparison (4 of 5")
    assert warned(doc, "line l1: found only by a second")[0].endswith(f"check it (conf at most {SECOND_PASS_CONF_LOW})")


@pytest.mark.parametrize(
    "keys, cap", [(2, 0.35), (3, 0.35), (5, 0.35), (6, 0.37), (8, 0.41), (11, 0.47), (12, 0.49), (40, 0.49)]
)
def test_lines_found_by_the_second_look_stay_below_one_half_and_short_lines_lower(keys, cap):
    # However many of its sounds matched: the line was found only among the leftovers.
    for exact in {min(keys, 3), keys}:
        d = _Decision(present=True, exact_keys=exact, total_keys=keys, second=exact / keys)
        assert _second_cap(d) == cap
    assert SECOND_PASS_CONF_LOW <= cap <= SECOND_PASS_CONF_HIGH < 0.5


def test_only_leftover_stretches_made_of_fillers_are_left_out_of_the_second_look():
    units = [u for text in ("らふうん", "まえに") for u in tokenize(text, "ja")]
    near = [Heard(u, 1.0 + k * 0.4, 1.35 + k * 0.4, None, 0) for k, u in enumerate(units)]
    assert _without_filler_stretches(near, list(range(7))) == list(range(7))  # one stretch, with words in it
    assert _without_filler_stretches(near, [0, 1, 2, 3, 5, 6]) == [5, 6]  # ま was explained: え stays with に
    far = near[:4] + [Heard(h.unit, h.start + 5.0, h.end + 5.0, None, 0) for h in near[4:]]
    assert _without_filler_stretches(far, list(range(7))) == [4, 5, 6]  # ad-libs seconds before the word


def test_a_short_line_is_not_found_again_among_the_ad_libs_of_a_harmony():
    # The lead sings the short line あ、ねえ (three sounds, all of them fillers). The harmony only
    # throws in "あ ら ね え" there and joins for the last line. Nothing in the whole-song
    # alignment gives those ad-libs to the short line on the harmony track; compared on its own
    # with the leftovers, it would match all three sounds by chance.
    lines = ["あ、ねえ", "ねえ、あなたははしってた", "とおいまちへてがみをかく"]
    units = [[u.text for u in tokenize(text, "ja")] for text in lines]  # sung() takes one unit per item
    lead = sung(units, [0, 1, 3])  # type: ignore[arg-type]
    adlibs = [TruthToken(ch, round(1.0 + k * 0.4, 3), round(1.35 + k * 0.4, 3)) for k, ch in enumerate("あらねえ")]
    harmony = adlibs + sung(units[2:], [3])  # type: ignore[arg-type]
    truths = [lead, harmony]
    inputs = [track(t, 4, name=f"t{k}.wav") for k, t in enumerate(truths)]
    doc = build_multitrack(inputs, FakeAsr(lead, tracks=truths), FakeAligner(lead, tracks=truths), lyrics="\n".join(lines))
    assert validate_output(doc) == []
    assert who(doc) == {"l1": ["t1"], "l2": ["t1"], "l3": ["t1", "t2"]}
    l1 = by_id(doc["tracks"][1])["l1"]
    assert not l1["sung"] and l1["absent_reason"] is not None
    assert not warned(doc["tracks"][1], "line l1: found only by a second")


LONG = ["春风吹过山岗上", "小河流向远方去", "我们一起来歌唱吧朋友", "夜色慢慢地降临"]


def test_a_harmony_that_joins_for_the_end_of_a_line_is_on_that_line():
    lead = sung(LONG, [0, 1, 2, 4])
    double = sung(LONG, [0, 1, 2, 4])
    start = next(t.start for t in lead if t.text == "唱")
    harmony = [TruthToken(ch, round(start + k * 0.4, 3), round(start + k * 0.4 + 0.35, 3)) for k, ch in enumerate("唱吧朋友")]
    truths = [lead, double, harmony]
    inputs = [track(t, 5, name=f"t{k}.wav") for k, t in enumerate(truths)]
    doc = build_multitrack(inputs, FakeAsr(lead, tracks=truths), FakeAligner(lead, tracks=truths), lyrics="\n".join(LONG))
    assert validate_output(doc) == []
    assert who(doc)["l3"] == ["t1", "t2", "t3"]
    l3 = by_id(doc["tracks"][2])["l3"]
    assert [t["text"] for t in l3["tokens"]] == list("唱吧朋友") and l3["start"] == pytest.approx(start, abs=0.06)
    assert max(t["conf"] for t in l3["tokens"]) < 0.5
    assert warned(doc["tracks"][2], "line l3: only part of it was heard on this track (4 of 10")
    # On its own, four sounds of ten are not enough.
    alone = build_timeline(inputs[2].x, FakeAsr(harmony), FakeAligner(harmony), lyrics="\n".join(LONG))
    assert not by_id(alone)["l3"]["sung"]


# --- Across tracks -----------------------------------------------------------------------------

SIX = EIGHT[:6]


def far_tracks(second_slots: list[int]) -> tuple[list[list[TruthToken]], list[TrackInput]]:
    lead = sung(SIX, [0, 1, 2, 3, 4, 5])
    second = sung(SIX[:4], second_slots)
    stray = sung([SIX[5]], [0])  # sounds like line 6, at the time of line 1
    truths = [lead, second, stray]
    return truths, [track(t, 6, name=f"t{k}.wav") for k, t in enumerate(truths)]


def test_a_line_heard_far_from_where_the_other_tracks_sing_it_does_not_count():
    truths, inputs = far_tracks([0, 1, 2, 3])
    doc = build_multitrack(inputs, FakeAsr(truths[0], tracks=truths), FakeAligner(truths[0], tracks=truths), lyrics="\n".join(SIX))
    assert who(doc)["l6"] == ["t1"]
    third = by_id(doc["tracks"][2])["l6"]
    assert not third["sung"] and third["absent_reason"] == "not_in_track"
    assert warned(doc["tracks"][2], "line l6: heard around 2.4 s, but the other tracks sing it around")
    assert not any("share one timeline" in w for w in doc["warnings"])


def test_tracks_whose_shared_lines_disagree_in_time_are_not_compared():
    truths, inputs = far_tracks([0, 2, 3, 5])  # the second track sings the shared lines at other times
    doc = build_multitrack(inputs, FakeAsr(truths[0], tracks=truths), FakeAligner(truths[0], tracks=truths), lyrics="\n".join(SIX))
    assert any("do not seem to share one timeline" in w for w in doc["warnings"])
    assert who(doc)["l6"] == ["t1", "t3"]  # no check across tracks: each track is judged on its own


def test_a_track_exported_with_an_offset_is_compared_after_removing_it():
    lead = sung(SIX, [0, 1, 2, 3, 4, 5])
    shifted = sung(SIX, [0, 1, 2, 3, 4, 5], start=4.0)
    truths = [lead, lead, shifted]
    inputs = [TrackInput(synth_vocal(t, duration=song_length(6) + 3.0), f"t{k}.wav", SR, None) for k, t in enumerate(truths)]
    doc = build_multitrack(inputs, FakeAsr(lead, tracks=truths), FakeAligner(lead, tracks=truths), lyrics="\n".join(SIX))
    assert any(w.startswith("track t3 seems to run 3.0 s later") for w in doc["warnings"])
    assert all(len(v) == 3 for v in who(doc).values())
    assert by_id(doc["tracks"][2])["l1"]["start"] == pytest.approx(4.0, abs=0.06)  # reported unchanged


@pytest.mark.parametrize("shift", [10.0, 2.9])
def test_of_two_tracks_only_the_one_that_is_off_is_reported_with_the_whole_offset(shift):
    # With two tracks the offset used to be split between them: 10 s became 5 s on each, and 2.9 s
    # became 1.45 s on each, which is within the tolerance on both, so it was taken for none.
    first = sung(SIX, [0, 1, 2, 3, 4, 5])
    second = sung(SIX, [0, 1, 2, 3, 4, 5], start=1.0 + shift)
    truths = [first, second]
    inputs = [TrackInput(synth_vocal(t, duration=song_length(6) + shift), f"t{k}.wav", SR, None) for k, t in enumerate(truths)]
    doc = build_multitrack(inputs, FakeAsr(first, tracks=truths), FakeAligner(first, tracks=truths), lyrics="\n".join(SIX))
    offsets = [w for w in doc["warnings"] if "seems to run" in w]
    assert len(offsets) == 1 and offsets[0].startswith(f"track t2 seems to run {shift:.1f} s later than the other tracks")
    assert all(v == ["t1", "t2"] for v in who(doc).values())
    assert by_id(doc["tracks"][0])["l3"]["start"] == pytest.approx(first[14].start, abs=0.06)
    assert by_id(doc["tracks"][1])["l3"]["start"] == pytest.approx(second[14].start, abs=0.06)  # reported unchanged


def test_the_multi_track_shape_checks_the_language_source_and_each_sung_by_entry():
    truths, inputs = far_tracks([0, 1, 2, 3])
    doc = build_multitrack(inputs, FakeAsr(truths[0], tracks=truths), FakeAligner(truths[0], tracks=truths), lyrics="\n".join(SIX))
    assert validate_output(doc) == []

    def broken(change) -> list[str]:
        bad = copy.deepcopy(doc)
        change(bad)
        return validate_output(bad)

    assert broken(lambda d: d.update(language_source="guess")) == ["language_source must be lyrics, asr or user"]
    assert broken(lambda d: d["lyric_lines"][0]["sung_by"][0].update(line="l2")) == [
        "lyric line l1: sung_by line l2 is not that sung line of t1"
    ]
    entry = {"track": "t3", "line": "l6", "start": 2.0, "end": 4.0, "conf": 0.9}  # t3 does not sing l6
    assert broken(lambda d: d["lyric_lines"][5]["sung_by"].append(entry)) == ["lyric line l6: sung_by line l6 is not that sung line of t3"]
    assert broken(lambda d: d["lyric_lines"][0]["sung_by"][0].update(conf=1.5)) == ["bad sung_by conf in l1"]


@pytest.mark.parametrize("other_sings_it", [True, False])
def test_a_gap_is_not_filled_with_a_line_another_track_sings_there(other_sings_it):
    hum = [TruthToken("嗯", round(1.0 + LINE_SEC + k * 0.4, 3), round(1.35 + LINE_SEC + k * 0.4, 3)) for k in range(4)]
    first = sung([EIGHT[0]], [0]) + hum + sung([EIGHT[2]], [2])
    second = sung([EIGHT[1]], [1]) if other_sings_it else sung([EIGHT[3]], [3])
    truths = [first, second]
    inputs = [track(t, 4, name=f"t{k}.wav") for k, t in enumerate(truths)]
    lyrics = "\n".join(EIGHT[:4])
    doc = build_multitrack(inputs, FakeAsr(first, drop={"嗯"}, tracks=truths), FakeAligner(first, tracks=truths), lyrics=lyrics)
    l2 = by_id(doc["tracks"][0])["l2"]
    assert l2["sung"] is not other_sings_it
    assert who(doc)["l2"] == (["t2"] if other_sings_it else ["t1"])


# --- Times from the aligner --------------------------------------------------------------------


class StuckAligner(FakeAligner):
    """Returns a zero-length span for one character, as the real aligner sometimes does."""

    def align(self, audio, start, end, units, language):
        spans = super().align(audio, start, end, units, language)
        return [(a, a) if u.text == "河" else (a, b) for u, (a, b) in zip(units, spans)]


class SilentAligner(FakeAligner):
    """Returns no times at all when asked to align line 2 on its own."""

    def align(self, audio, start, end, units, language):
        if [u.text for u in units] == list(EIGHT[1]):
            return []
        return super().align(audio, start, end, units, language)


def test_a_line_on_the_track_that_the_aligner_cannot_time_says_why_it_has_no_times():
    truth = sung(EIGHT[:3], [0, 1, 2])
    doc = build_timeline(track(truth, 3).x, FakeAsr(truth), SilentAligner(truth), lyrics="\n".join(EIGHT[:3]))
    assert validate_output(doc) == []
    l2 = by_id(doc)["l2"]
    assert (l2["sung"], l2["absent_reason"], l2["tokens"], l2["start"]) == (False, "no_alignment", [], None)
    assert warned(doc, "line l2: found on this track, but the aligner returned no times for it")
    assert by_id(doc)["l1"]["sung"] and by_id(doc)["l3"]["sung"]
    # Several tracks: the line is not listed as sung on that track.
    truths = [truth, sung(EIGHT[1:3], [1, 2])]
    inputs = [track(t, 3, name=f"t{k}.wav") for k, t in enumerate(truths)]
    multi = build_multitrack(inputs, FakeAsr(truth, tracks=truths), SilentAligner(truth, tracks=truths), lyrics="\n".join(EIGHT[:3]))
    assert validate_output(multi) == []
    assert who(multi)["l2"] == [] and [by_id(t)["l2"]["absent_reason"] for t in multi["tracks"]] == ["no_alignment"] * 2


def test_a_line_without_times_must_say_why():
    truth = sung([EIGHT[0], EIGHT[2]], [0, 2])  # line 2 is not sung
    doc = build_timeline(track(truth, 3).x, FakeAsr(truth), FakeAligner(truth), lyrics="\n".join(EIGHT[:3]))
    assert validate_output(doc) == [] and by_id(doc)["l2"]["absent_reason"] == "not_in_track"
    bad = copy.deepcopy(doc)
    by_id(bad)["l2"]["absent_reason"] = None
    assert validate_output(bad) == ["line l2 is not sung but its absent_reason is None"]
    by_id(bad)["l2"]["absent_reason"] = "missing"
    assert validate_output(bad) == ["line l2 is not sung but its absent_reason is 'missing'"]
    bad = copy.deepcopy(doc)
    by_id(bad)["l1"]["absent_reason"] = "no_alignment"
    assert validate_output(bad) == ["sung line l1 has an absent_reason"]


def test_a_zero_length_span_takes_the_time_up_to_the_next_unit_with_low_confidence():
    truth = sung(EIGHT[:2], [0, 1])
    doc = build_timeline(track(truth, 2).x, FakeAsr(truth), StuckAligner(truth), lyrics="\n".join(EIGHT[:2]))
    tok = next(t for t in by_id(doc)["l2"]["tokens"] if t["text"] == "河")
    nxt = next(t for t in by_id(doc)["l2"]["tokens"] if t["text"] == "流")
    assert tok["end"] - tok["start"] > 0.3 and tok["end"] <= nxt["start"] + 1e-6
    assert tok["conf"] <= APPROX_CONF_CAP


class SqueezingAligner(FakeAligner):
    """Gives one character only 50 ms and lets the next one start right after it."""

    def align(self, audio, start, end, units, language):
        spans = super().align(audio, start, end, units, language)
        texts = [u.text for u in units]
        if "河" in texts:
            k = texts.index("河")
            a = spans[k][0]
            spans[k] = (a, a + 0.05)
            if k + 1 < len(spans):
                spans[k + 1] = (a + 0.05, spans[k + 1][1])
        return spans


def test_a_token_that_snapping_squeezes_to_almost_nothing_has_low_confidence():
    truth = sung(EIGHT[:2], [0, 1])
    river = next(t.start for t in truth if t.text == "河")
    notes = [Note(0, river + 0.045, river + 0.4)]  # both starts snap to this note
    doc = build_timeline(track(truth, 2).x, FakeAsr(truth), SqueezingAligner(truth), lyrics="\n".join(EIGHT[:2]), notes=notes)
    tok = next(t for t in by_id(doc)["l2"]["tokens"] if t["text"] == "河")
    assert tok["end"] - tok["start"] < 0.02 and tok["conf"] <= APPROX_CONF_CAP
    assert validate_output(doc) == []


def test_voiced_start_stays_inside_tokens_whose_times_are_off_the_frame_grid():
    # Units put back into their chunk, or spread over a zero-length span, get times between frames;
    # here an ad-lib inside the line starts 3 ms after a frame.
    truth = sung(["春风吹过啊山岗上"], [0])
    doc = build_timeline(track(truth, 2).x, FakeAsr(truth), FakeAligner(truth, noise=0.003), lyrics=EIGHT[0])
    adlib = next(t for t in doc["lines"][0]["tokens"] if t["type"] == "adlib")
    assert adlib["start"] <= adlib["voiced_start"] <= adlib["end"]
    assert validate_output(doc) == []


def test_zero_length_spans_are_spread_up_to_the_next_start_and_capped():
    spans, rough = _spread_zero_spans([(1.0, 1.4), (2.0, 2.0), (2.0, 2.0), (2.6, 3.0), (5.0, 5.0)], 9.0)
    assert spans[1] == pytest.approx((2.0, 2.3)) and spans[2] == pytest.approx((2.3, 2.6))
    assert spans[4] == pytest.approx((5.0, 6.0))  # at most one second per unit at the end of the line
    assert rough == {1, 2, 4} and spans[0] == (1.0, 1.4) and spans[3] == (2.6, 3.0)


def test_units_placed_outside_their_chunk_are_put_back():
    chunks = [(0.0, 5.0)] * 2 + [(30.0, 36.0)] * 3
    spans = [(1.0, 1.5), (2.0, 2.5), (3.0, 3.2), (3.3, 3.5), (31.0, 31.5)]  # the 3rd and 4th belong after 30 s
    out = _keep_in_chunks(spans, chunks)
    assert out[:2] == spans[:2] and out[4] == spans[4]
    assert out[2] == pytest.approx((30.0, 30.5)) and out[3] == pytest.approx((30.5, 31.0))


def _heard(times: list[tuple[float, float, int]]) -> list[Heard]:
    unit = tokenize("啊", "zh")[0]
    return [Heard(unit, a, b, None, c) for a, b, c in times]


def test_matches_of_a_line_are_one_stretch_while_they_follow_each_other_in_one_chunk():
    heard = _heard([(1.0, 1.2, 0), (4.6, 4.8, 0), (9.0, 9.2, 0), (13.0, 13.2, 1)])
    assert _clusters(heard, [0, 1]) == [[0, 1]]  # 3.4 s apart, but nothing else was heard between them
    assert _clusters(heard, [0, 2]) == [[0], [2]]  # another unit lies between them
    assert _clusters(heard, [2, 3]) == [[2], [3]]  # next to each other, but in different chunks


# --- Alignment of one line inside a longer stretch ---------------------------------------------


def test_align_within_places_the_line_on_the_stretch_that_fits_it():
    pairs = align_within(list("cdef"), list("xxcdzfyy"))
    exact = [(p.lyric, p.heard) for p in pairs if p.exact]
    assert exact == [(0, 2), (1, 3), (3, 5)]
    assert {p.lyric for p in pairs if p.lyric is not None} == {0, 1, 2, 3}
    assert all(p.heard is None or 2 <= p.heard <= 5 for p in pairs)  # heard keys outside the stretch are left out


def test_align_within_with_empty_sides():
    assert [(p.lyric, p.heard) for p in align_within(list("ab"), [])] == [(0, None), (1, None)]
    assert align_within([], list("ab")) == []
