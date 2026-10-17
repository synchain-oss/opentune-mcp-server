# SPDX-License-Identifier: MIT
"""Languages other than Chinese and English: units, comparison keys, language choice."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from conftest import synth_vocal
from lytl import japanese as ja
from lytl import langs
from lytl import normalize as nz
from lytl.backends import FakeAligner, FakeAsr, QwenAligner, QwenAsr, TruthToken, aligner_language_name, project_items
from lytl.lyrics import parse_lyrics
from lytl.pipeline import build_timeline
from lytl.schema import validate_output

needs_readings = pytest.mark.skipif(not ja.have_readings(), reason="SudachiPy / SudachiDict-core not installed")


def script(lines: list[list[str]], start: float = 1.0, unit: float = 0.35, gap: float = 0.05, line_gap: float = 1.0):
    """Truth tokens for lines of sung units, one after another."""
    out, t = [], start
    for line in lines:
        for text in line:
            out.append(TruthToken(text, round(t, 3), round(t + unit, 3)))
            t += unit + gap
        t += line_gap - gap
    return out


def units_of(text: str, lang: str) -> list[str]:
    return [u.text for u in nz.tokenize(text, lang)]


# --- Units and keys ----------------------------------------------------------------------------


def test_japanese_units_are_kanji_and_kana_syllables_with_words_for_latin():
    assert units_of("君と dance したい", "ja") == ["君", "と", "dance", "し", "た", "い"]
    assert [u.kind for u in nz.tokenize("君と dance", "ja")] == ["char", "char", "word"]
    # Small kana, the sokuon and the long-vowel mark stay with the kana before them (one sung note).
    assert units_of("ちゃんと行った ワー", "ja") == ["ちゃ", "ん", "と", "行", "っ", "た", "ワー"]
    assert units_of("ｷｬｯﾁ", "ja") == ["キャッ", "チ"]  # half-width kana are normalised first


def test_japanese_is_not_folded_to_simplified_chinese():
    assert units_of("愛してる", "ja")[0] == "愛"
    assert units_of("愛してる", "zh")[0] == "爱"


@needs_readings
def test_japanese_keys_are_readings_so_kanji_and_kana_compare_equal():
    def keys(text: str) -> list[str]:
        return [k for k, _ in nz.match_sequence(text, "ja")[1]]

    assert keys("君") == keys("きみ") == ["キ", "ミ"]
    assert keys("想い") == keys("思い") == ["オ", "モ", "イ"]
    # Okurigana: 想 owns オモ, い owns イ. Two kanji with one reading share it.
    units, seq = nz.match_sequence("想い今日", "ja")
    assert [u.text for u in units] == ["想", "い", "今", "日"]
    assert seq[:3] == [("オ", (0,)), ("モ", (0,)), ("イ", (1,))]
    assert seq[3:] == [("キョ", (2, 3)), ("ウ", (2, 3))]
    assert keys("タワー") == keys("たわあ")  # the long-vowel mark sounds like the vowel before it
    assert keys("を") == keys("お")


def test_korean_units_are_words_and_keys_are_syllables():
    units, seq = nz.match_sequence("사랑해 너를", "ko")
    assert [(u.text, u.kind) for u in units] == [("사랑해", "word"), ("너를", "word")]
    assert seq == [("사", (0,)), ("랑", (0,)), ("해", (0,)), ("너", (1,)), ("를", (1,))]


def test_latin_and_cyrillic_words_fold_accents_and_apostrophes():
    assert nz.word_key("Été") == nz.word_key("ete") == "ete"
    assert nz.word_key("corazón") == "corazon" and nz.word_key("Schön") == "schon"
    assert nz.word_key("l'amour") == "lamour"
    assert units_of("Je t'aime, à la folie", "fr") == ["je", "t'aime", "à", "la", "folie"]  # the text keeps its accents
    assert units_of("Я люблю тебя", "ru") == ["я", "люблю", "тебя"]
    assert units_of("Ich bin 21", "de") == ["ich", "bin", "21"]  # digits stay as written outside zh / en


def test_fillers_in_more_languages():
    f = nz.is_filler
    assert f(nz.Unit("あ", "char")) and f(nz.Unit("ねえ"[0], "char")) and f(nz.Unit("あー", "char"))
    assert f(nz.Unit("아", "word")) and f(nz.Unit("오오", "word")) and not f(nz.Unit("사랑", "word"))
    assert not f(nz.Unit("君", "char")) and not f(nz.Unit("か", "char"))


def test_script_detection():
    assert langs.script_language("君が好きだと言えなくて") == "ja"
    assert langs.script_language("永遠に君と") == "ja"
    assert langs.script_language("我爱你有多深") == "zh"
    assert langs.script_language("사랑해 love") == "ko"
    assert langs.script_language("Я люблю тебя") == "ru"
    assert langs.script_language("I love you so") == "latin"
    assert langs.script_language("ฉันรักเธอ") == "th"
    assert langs.script_language("123 !!") is None


# --- Choosing the language ---------------------------------------------------------------------


def test_lyrics_decide_the_language_even_when_the_recogniser_says_otherwise():
    assert langs.decide_language("auto", "君が好き", [("en", 10)], "") == ("ja", "lyrics", [])
    assert langs.decide_language("auto", "我爱你", [("ja", 10)], "") == ("zh", "lyrics", [])


def test_latin_lyrics_use_the_recognisers_latin_language_or_english():
    assert langs.decide_language("auto", "je t'aime", [("fr", 10), ("en", 2)], "")[:2] == ("fr", "asr")
    assert langs.decide_language("auto", "je t'aime", [(None, 10)], "")[:2] == ("en", "lyrics")
    lang, source, warnings = langs.decide_language("auto", "ik hou van jou", [("nl", 10)], "")
    assert (lang, source) == ("en", "lyrics") and "Dutch" in warnings[0]


def test_without_lyrics_the_recognisers_report_comes_first():
    assert langs.decide_language("auto", None, [("ja", 12), ("en", 3)], "君")[:2] == ("ja", "asr")
    assert langs.decide_language("auto", None, [(None, 5)], "사랑해")[:2] == ("ko", "asr")
    assert langs.decide_language("ko", "君", [("ja", 9)], "")[:2] == ("ko", "user")


def test_unsupported_languages_are_clear_errors_that_list_the_supported_ones():
    with pytest.raises(langs.UnsupportedLanguage, match=r"Thai \(th\) can be recognised.*supported languages: zh \(Chinese\)"):
        langs.check_language("th")
    with pytest.raises(langs.UnsupportedLanguage, match="unknown language code 'xx'"):
        langs.check_language("xx")
    with pytest.raises(langs.UnsupportedLanguage, match="Thai"):
        langs.precheck("auto", "ฉันรักเธอมาก")
    with pytest.raises(langs.UnsupportedLanguage, match="Vietnamese"):
        langs.decide_language("auto", None, [("vi", 20)], "")
    langs.precheck("auto", "I love you")  # Latin: decided after recognition, no error yet
    assert set(langs.ALIGNER_LANGUAGES) == {"zh", "yue", "en", "de", "es", "fr", "it", "pt", "ru", "ko", "ja"}


def test_pipeline_reports_the_language_and_its_source():
    truth = script([["i", "love", "you"]])
    x = synth_vocal(truth)
    doc = build_timeline(x, FakeAsr(truth, reported_language="fr"), FakeAligner(truth), lyrics="I love you")
    assert (doc["language"], doc["language_source"]) == ("fr", "asr")
    doc = build_timeline(x, FakeAsr(truth, reported_language="fr"), FakeAligner(truth), lyrics="I love you", language="en")
    assert (doc["language"], doc["language_source"]) == ("en", "user")
    doc = build_timeline(x, FakeAsr(truth, reported_language="en"), FakeAligner(truth), lyrics=None)
    assert (doc["language"], doc["language_source"]) == ("en", "asr")
    with pytest.raises(langs.UnsupportedLanguage):
        build_timeline(x, FakeAsr(truth, reported_language="vi"), FakeAligner(truth), lyrics=None)


# --- Whole pipeline in other languages ---------------------------------------------------------

JA_LYRICS = "君が好きだと\n想いを伝えて\n君と dance したい"


@needs_readings
def test_japanese_lyrics_match_a_recogniser_that_writes_other_characters():
    lines = [units_of(t, "ja") for t in JA_LYRICS.splitlines()]
    truth = script(lines)
    # The recogniser writes 君 as きみ and 想 as 思 (same readings), and reports English.
    heard_as = {"君": "きみ", "想": "思"}
    asr = FakeAsr(truth, substitutions=heard_as, reported_language="en")
    doc = build_timeline(synth_vocal(truth), asr, FakeAligner(truth, renditions=heard_as), lyrics=JA_LYRICS)
    assert validate_output(doc) == []
    assert (doc["language"], doc["language_source"]) == ("ja", "lyrics")
    assert all(ln["sung"] for ln in doc["lines"])
    assert [d for d in doc["diffs"] if d["type"] in ("not_sung", "heard_differently", "adlib")] == []
    assert doc["unmatched"] == [] and doc["adlibs"] == []
    first = doc["lines"][0]["tokens"][0]
    assert (first["text"], first["i"], first["type"]) == ("君", 1, "char")
    assert first["start"] == pytest.approx(truth[0].start, abs=0.06)
    third = doc["lines"][2]["tokens"]
    assert [t["text"] for t in third] == ["君", "と", "dance", "し", "た", "い"]
    assert third[2]["type"] == "word"


def test_korean_words_match_when_the_recogniser_splits_them_differently():
    truth = script([["사랑해", "너를"], ["보고", "싶어"]], unit=0.5)
    heard_as = {"사랑해": "사랑 해"}
    doc = build_timeline(
        synth_vocal(truth), FakeAsr(truth, substitutions=heard_as), FakeAligner(truth, renditions=heard_as),
        lyrics="사랑해 너를\n보고 싶어",
    )
    assert doc["language"] == "ko" and all(ln["sung"] for ln in doc["lines"])
    assert [t["text"] for t in doc["lines"][0]["tokens"]] == ["사랑해", "너를"]
    assert not [d for d in doc["diffs"] if d["type"] in ("not_sung", "adlib")]


@pytest.mark.parametrize(
    "lang, lyrics, heard",
    [
        ("fr", "Je t'aime à la folie", "je taime a la folie"),
        ("de", "Schön über alles", "schon uber alles"),
        ("es", "Mi corazón está aquí", "mi corazon esta aqui"),
    ],
)
def test_accents_do_not_break_the_comparison(lang, lyrics, heard):
    truth = script([heard.split()], unit=0.4)
    doc = build_timeline(synth_vocal(truth), FakeAsr(truth), FakeAligner(truth), lyrics=lyrics, language=lang)
    assert doc["lines"][0]["sung"]
    assert [d for d in doc["diffs"] if d["type"] in ("heard_differently", "not_sung")] == []
    assert doc["lines"][0]["tokens"][0]["text"] == lyrics.split()[0].lower()


def test_russian_words():
    truth = script([["я", "люблю", "тебя"]], unit=0.4)
    doc = build_timeline(synth_vocal(truth), FakeAsr(truth), FakeAligner(truth), lyrics="Я люблю тебя")
    assert doc["language"] == "ru" and [t["text"] for t in doc["lines"][0]["tokens"]] == ["я", "люблю", "тебя"]


# --- The real back ends' glue (no model) -------------------------------------------------------


def test_aligner_words_are_projected_onto_units_by_text():
    item = lambda text, a, b: SimpleNamespace(text=text, start_time=a, end_time=b)  # noqa: E731
    units = nz.tokenize("君が好き", "ja")
    spans = project_items([item("君", 0.0, 0.5), item("が", 0.5, 0.7), item("好き", 0.7, 1.5)], units)
    assert spans == [(0.0, 0.5), (0.5, 0.7), (0.7, pytest.approx(1.1)), (pytest.approx(1.1), 1.5)]
    assert project_items([item("君", 0.0, 0.5)], units) is None  # different characters: no projection

    al = object.__new__(QwenAligner)
    seen = {}

    def fake_align(audio, text, language):
        seen["language"] = language
        return [[item("君", 0.0, 0.5), item("が", 0.5, 0.7), item("好き", 0.7, 1.5)]]

    al.model = SimpleNamespace(align=fake_align)
    out = al.align(None, 10.0, 12.0, units, "ja")
    assert len(out) == 4 and out[0] == (10.0, 10.5) and al.last_mismatch is None
    assert seen["language"] == "Japanese"


def test_korean_never_selects_the_aligners_soynlp_splitter():
    assert aligner_language_name("ko") not in ("Korean", "korean")
    assert aligner_language_name("ja") == "Japanese" and aligner_language_name("yue") == "Cantonese"


def test_qwen_asr_reports_the_language_it_heard():
    asr = object.__new__(QwenAsr)
    asked = {}

    def fake_transcribe(audio, language):
        asked["language"] = language
        return [SimpleNamespace(text="君が好き", language="Japanese")]

    asr.model = SimpleNamespace(transcribe=fake_transcribe)
    assert asr.transcribe(None, 0.0, 1.0, "auto") == "君が好き" and asr.last_language == "ja"
    assert asked["language"] is None
    asr.transcribe(None, 0.0, 1.0, "ko")
    assert asked["language"] == "Korean"
    asr.model = SimpleNamespace(transcribe=lambda audio, language: [SimpleNamespace(text="x", language="Chinese,English")])
    asr.transcribe(None, 0.0, 1.0, "auto")
    assert asr.last_language == "zh"


def test_singer_marks_do_not_collide_with_tags_or_backing():
    p = parse_lyrics("[Chorus]\n{A} (oh yeah)\n{B}\nline b\n[Verse 2]\nline c\n{}\nline d")
    assert [(ln.text, ln.backing, ln.singers, ln.label) for ln in p.lines] == [
        ("oh yeah", True, ("A",), "chorus"),
        ("line b", False, ("B",), "chorus"),
        ("line c", False, ("B",), "verse"),
        ("line d", False, (), "verse"),
    ]


def test_without_japanese_readings_the_result_says_so(monkeypatch):
    monkeypatch.setattr(ja, "_TRIED", True)
    monkeypatch.setattr(ja, "_TOKENIZER", None)
    truth = script([units_of("君が好き", "ja")])
    doc = build_timeline(synth_vocal(truth), FakeAsr(truth), FakeAligner(truth), lyrics="君が好き")
    assert doc["lines"][0]["sung"]  # same characters still compare equal
    assert any("Japanese readings (SudachiPy with SudachiDict-core) are not installed" in w for w in doc["warnings"])


def test_setup_plan_lists_the_japanese_readings(capsys, tmp_path):
    import setup as setup_script  # noqa: PLC0415

    plan = setup_script.build_plan("0.6B", "hf", "cpu", str(tmp_path))
    assert plan["japanese_readings"]["packages"] == ["sudachipy", "sudachidict-core"]
    assert plan["total_approx_bytes"] == plan["model_bytes"] + plan["torch"]["approx_bytes"] + plan["packages_approx_bytes"] + plan["japanese_readings"]["approx_bytes"]
    setup_script.print_plan(plan)
    assert "Japanese       : SudachiPy + SudachiDict-core" in capsys.readouterr().out
    reqs = open(setup_script.REQUIREMENTS, encoding="utf-8").read()
    assert "sudachipy==0.7.0" in reqs and "sudachidict-core==20261015" in reqs
