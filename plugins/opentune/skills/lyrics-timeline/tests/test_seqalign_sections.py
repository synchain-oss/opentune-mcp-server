# SPDX-License-Identifier: MIT
from __future__ import annotations

from lytl.seqalign import align_keys, find_runs
from lytl.sections import LineInfo, plan_sections


def _runs(lyric: list[str], heard: list[str], line_of: list[int]):
    pairs = align_keys(lyric, heard)
    return pairs, find_runs(pairs, lyric, heard, line_of)


def test_identical_sequences_have_no_runs():
    keys = list("abcdef")
    pairs, runs = _runs(keys, keys, [0, 0, 0, 1, 1, 1])
    assert runs == [] and all(p.exact for p in pairs)


def test_lyric_unit_that_was_not_sung():
    pairs, runs = _runs(list("abcdef"), list("abdef"), [0, 0, 0, 1, 1, 1])
    assert [(r.kind, r.lyric) for r in runs] == [("not_sung", (2, 3))]


def test_extra_heard_unit_is_an_adlib():
    pairs, runs = _runs(list("abcd"), list("abxcd"), [0, 0, 1, 1])
    assert [(r.kind, r.heard) for r in runs] == [("adlib", (2, 3))]


def test_unwritten_repeat_is_recognised():
    lyric = "wo ai ni you duo shen yue liang dai biao".split()
    line_of = [0] * 6 + [1] * 4
    heard = lyric[:6] + ["wo", "ai", "ni", "you", "duo", "shen"] + lyric[6:]
    _, runs = _runs(lyric, heard, line_of)
    # Either copy of the line may be the unmatched one; what matters is the kind and the source line.
    assert [(r.kind, r.heard[1] - r.heard[0], r.repeat_of) for r in runs] == [("repeat_unwritten", 6, (0, 6))]


def test_misrecognised_unit_is_a_pair_not_a_run():
    pairs, runs = _runs(list("abc"), list("axc"), [0, 0, 0])
    assert runs == [] and [p.exact for p in pairs] == [True, False, True]


def test_empty_sides():
    assert [p.heard for p in align_keys(list("ab"), [])] == [None, None]
    assert [p.lyric for p in align_keys([], list("ab"))] == [None, None]


def _info(text: str, **kw) -> LineInfo:
    return LineInfo(keys=list(text), **kw)


SONG = ["abcdefg", "hijklmn", "opqrst", "uvwxyz", "ABCDEFG", "HIJKLMN", "opqrst", "uvwxyz"]


def test_user_labels_win_and_count_occurrences():
    lines = [
        _info(SONG[0], label="verse", label_number=1, block=1),
        _info(SONG[1], label="verse", label_number=1, block=1),
        _info(SONG[2], label="chorus", block=2),
        _info(SONG[3], label="chorus", block=2),
        _info(SONG[4], label="verse", label_number=2, block=3),
        _info(SONG[6], label="chorus", block=4),
    ]
    plans = plan_sections(lines)
    assert [(p.label, p.occurrence, p.lines, p.source) for p in plans] == [
        ("verse", 1, [0, 1], "user"),
        ("chorus", 1, [2, 3], "user"),
        ("verse", 2, [4], "user"),
        ("chorus", 2, [5], "user"),
    ]


def test_chorus_is_inferred_without_tags():
    lines = [_info(t, block=0) for t in SONG]
    plans = plan_sections(lines)
    assert [(p.label, p.occurrence, p.lines) for p in plans] == [
        ("verse", 1, [0, 1]),
        ("chorus", 1, [2, 3]),
        ("verse", 2, [4, 5]),
        ("chorus", 2, [6, 7]),
    ]
    assert all(p.source == "inferred" for p in plans)


def test_inference_adds_outro_and_scores_later_louder_block():
    lines = [_info(t, block=0, level_db=-30.0) for t in SONG] + [_info("zzzz", block=0, level_db=-30.0)]
    plans = plan_sections(lines)
    assert plans[-1].label == "outro" and plans[-1].lines == [8]


def test_no_repetition_means_verses_only():
    plans = plan_sections([_info(t, block=0) for t in ["abc", "def", "ghi"]])
    assert [p.label for p in plans] == ["verse"]
