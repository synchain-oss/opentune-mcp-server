# SPDX-License-Identifier: MIT
from __future__ import annotations

import pytest

from lytl import normalize as nz
from lytl.lyrics import parse_lyrics


def test_section_tags_and_blocks():
    p = parse_lyrics("[Verse 1]\nline a\nline b\n\n【副歌】\nline c\n(Bridge)\nline d")
    assert p.has_labels
    assert [(ln.label, ln.label_number, ln.text) for ln in p.lines] == [
        ("verse", 1, "line a"),
        ("verse", 1, "line b"),
        ("chorus", None, "line c"),
        ("bridge", None, "line d"),
    ]
    assert len({ln.block for ln in p.lines}) == 3


def test_inline_tag_and_pre_chorus_spellings():
    p = parse_lyrics("[Pre-Chorus] la la\n[预副歌]\nnext")
    assert p.lines[0].label == "pre-chorus" and p.lines[0].text == "la la"
    assert p.lines[1].label == "pre-chorus"


def test_lrc_times_and_meta_are_stripped():
    p = parse_lyrics("[ti:Song]\n[ar:Someone]\n[00:12.50]first line\n[01:02.5][01:30.00]second")
    assert [ln.text for ln in p.lines] == ["first line", "second"]
    assert p.lines[0].lrc_time == pytest.approx(12.5)
    assert p.lines[1].lrc_time == pytest.approx(62.5)
    assert not p.has_labels


def test_repeat_markers_expand_lines():
    p = parse_lyrics("我爱你 ×2\nhello world x3\nMix2")
    texts = [ln.text for ln in p.lines]
    assert texts == ["我爱你"] * 2 + ["hello world"] * 3 + ["Mix2"]
    assert p.lines[1].expanded and not p.lines[0].expanded


def test_tag_repeat_expands_block_and_bare_tag_repeats_earlier_block():
    p = parse_lyrics("[Chorus x2]\nsing it\n[Verse]\nsome verse\n[Chorus]\n")
    assert [(ln.label, ln.text) for ln in p.lines] == [
        ("chorus", "sing it"),
        ("chorus", "sing it"),
        ("verse", "some verse"),
        ("chorus", "sing it"),
    ]


def test_bracketed_backing_vocals():
    p = parse_lyrics("(oh yeah)\nmain words (ooh) here")
    assert p.lines[0].backing and p.lines[0].text == "oh yeah"
    assert not p.lines[1].backing
    assert p.lines[1].text == "main words here" and p.lines[1].backing_text == "ooh"


def test_traditional_table_is_well_formed():
    assert all(len(pair) == 2 for pair in nz._T2S_PAIRS.split())
    assert nz.to_simplified("愛你一萬年，這個夢") == "爱你一万年，这个梦"


def test_digits_and_punctuation():
    assert nz.tokenize("我520 天!", "zh")[1:4] == [nz.Unit("五", "char"), nz.Unit("二", "char"), nz.Unit("零", "char")]
    assert [u.text for u in nz.tokenize("Don't stop, 3 times...", "en")] == ["don't", "stop", "three", "times"]
    assert [u.text for u in nz.tokenize("year 2024", "en")][-4:] == ["two", "zero", "two", "four"]


def test_mixed_language_is_one_sequence():
    units = nz.tokenize("我爱 you 你", "auto")
    assert [(u.text, u.kind) for u in units] == [("我", "char"), ("爱", "char"), ("you", "word"), ("你", "char")]
    assert nz.units_text(units) == "我爱 you 你"


def test_language_detection():
    assert nz.detect_language("我爱你 love") == "zh"
    assert nz.detect_language("I love you") == "en"


@pytest.mark.skipif(not nz.have_pinyin(), reason="pypinyin not installed")
def test_chinese_keys_ignore_tones_and_homophones():
    assert nz.Unit("爱", "char").key == nz.Unit("艾", "char").key == "ai"
    assert nz.Unit("深", "char").key == "shen"


def test_english_keys_are_lower_case_words():
    assert nz.Unit("don't", "word").key == "dont"


def test_fillers_and_homophone_groups():
    assert nz.is_filler(nz.Unit("啊", "char")) and nz.is_filler(nz.Unit("yeah", "word"))
    assert not nz.is_filler(nz.Unit("爱", "char"))
    assert "得" in nz.homophone_alternatives("的") and nz.homophone_alternatives("爱") == []
