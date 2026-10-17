# SPDX-License-Identifier: MIT
"""Japanese: units and reading-based comparison keys.

Units: one per kanji, one per kana syllable (a small kana, the sokuon っ and the long-vowel mark ー
join the kana before them, because they belong to the same sung note), one per Latin or digit word.

Keys: lyrics and the recogniser often write the same sound differently (君 / きみ, 想い / 思い), so
both sides are compared by reading. SudachiPy with SudachiDict-core gives the reading (katakana) of
every morpheme. Each morpheme's reading is split into morae and every mora remembers which unit it
came from: kana from themselves, the kanji of a morpheme from the part of the reading left over
after its kana (送り仮名). Several kanji that share one reading (今日 = キョウ) own those morae
together. The pipeline aligns the mora sequences and a unit counts as heard when any of its morae
is paired.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from .langs import is_han, is_kana
from .normalize import Unit, strip_punctuation, word_key

# Small kana, the sokuon and the long-vowel mark: part of the syllable (and the note) before them.
ATTACH = set("ぁぃぅぇぉゃゅょゎァィゥェォャュョヮっッー")
_SMALL = set("ァィゥェォャュョヮ")  # kana that form one mora with the kana before them
_VOWEL = {}
for _v, _row in zip("アイウエオ", ("アカサタナハマヤラワガザダバパァャヮ", "イキシチニヒミリギジヂビピィ",
                                  "ウクスツヌフムユルグズヅブプゥュヴ", "エケセテネヘメレゲゼデベペェ",
                                  "オコソトノホモヨロヲゴゾドボポォョ")):
    for _c in _row:
        _VOWEL[_c] = _v
# Spellings of one sound: ヲ is sung as オ, ヂ / ヅ as ジ / ズ, ヴ as the B row.
_SAME_SOUND = {"ヲ": "オ", "ヂ": "ジ", "ヅ": "ズ", "ヴァ": "バ", "ヴィ": "ビ", "ヴ": "ブ", "ヴェ": "ベ", "ヴォ": "ボ"}
_FILLER_BASES = set("あいうえおんねらふアイウエオンネラフ")

_TOKENIZER: Any = None
_TRIED = False


def _sudachi() -> Any:
    """SudachiPy's tokenizer with the core dictionary, or None when either is not installed."""
    global _TOKENIZER, _TRIED
    if not _TRIED:
        _TRIED = True
        try:
            from sudachipy import Dictionary, SplitMode  # type: ignore[import-not-found]

            _TOKENIZER = Dictionary(dict="core").tokenizer(mode=SplitMode.A)
        except Exception:  # noqa: BLE001 - a missing package or dictionary both mean "no readings"
            _TOKENIZER = None
    return _TOKENIZER


def have_readings() -> bool:
    return _sudachi() is not None


def to_katakana(text: str) -> str:
    return "".join(chr(ord(c) + 0x60) if 0x3041 <= ord(c) <= 0x3096 else c for c in text)


def _all_katakana(text: str) -> bool:
    return bool(text) and all(0x30A0 <= ord(c) <= 0x30FF for c in text)


def mora_spans(kata: str) -> list[tuple[int, int]]:
    """[start, end) of each mora of a katakana string; a small kana joins the mora before it."""
    out: list[tuple[int, int]] = []
    for i, ch in enumerate(kata):
        if ch in _SMALL and out and kata[out[-1][1] - 1] not in "ッンー":
            out[-1] = (out[-1][0], i + 1)
        else:
            out.append((i, i + 1))
    return out


def mora_keys(kata: str) -> list[str]:
    """Comparison keys of a katakana string: one per mora, spellings of one sound folded together."""
    keys: list[str] = []
    for a, b in mora_spans(kata):
        m = _SAME_SOUND.get(kata[a:b], kata[a:b])
        if m == "ー" and keys:  # a long-vowel mark sounds like the vowel before it
            m = _VOWEL.get(keys[-1][-1], "ー")
        keys.append(m)
    return keys


def ja_units(text: str) -> tuple[str, list[Unit], list[tuple[int, int]]]:
    """(cleaned text, units, [start, end) of each unit in the cleaned text)."""
    cleaned = strip_punctuation(unicodedata.normalize("NFKC", text))
    units: list[Unit] = []
    spans: list[tuple[int, int]] = []
    word_start: int | None = None

    def flush(end: int) -> None:
        nonlocal word_start
        if word_start is not None:
            units.append(Unit(cleaned[word_start:end].lower(), "word"))
            spans.append((word_start, end))
            word_start = None

    for i, ch in enumerate(cleaned):
        if ch == " ":
            flush(i)
        elif is_han(ch):
            flush(i)
            units.append(Unit(ch, "char"))
            spans.append((i, i + 1))
        elif is_kana(ch):
            flush(i)
            prev_kana = units and spans[-1][1] == i and units[-1].kind == "char" and is_kana(units[-1].text[-1])
            if ch in ATTACH and prev_kana:
                units[-1] = Unit(units[-1].text + ch, "char")
                spans[-1] = (spans[-1][0], i + 1)
            else:
                units.append(Unit(ch, "char"))
                spans.append((i, i + 1))
        elif word_start is None:
            word_start = i
    flush(len(cleaned))
    return cleaned, units, spans


def _own_keys(unit: Unit) -> list[str]:
    if unit.kind == "word":
        return [word_key(unit.text)]
    if all(is_kana(c) for c in unit.text):
        return mora_keys(to_katakana(unit.text))
    return [unit.text]


def _distribute(
    cleaned: str, owner: list[int], b: int, e: int, reading: str
) -> list[tuple[int, str, tuple[int, ...]]]:
    """Morae of one morpheme's reading as (char position, key, owning units)."""
    parts: list[tuple[str, int, int]] = []
    i = b
    while i < e:
        kana = is_kana(cleaned[i])
        j = i
        while j < e and is_kana(cleaned[j]) == kana:
            j += 1
        parts.append(("kana" if kana else "kanji", i, j))
        i = j
    regex = "".join("(" + re.escape(to_katakana(cleaned[a:z])) + ")" if k == "kana" else "(.+?)" for k, a, z in parts)
    m = re.fullmatch(regex, reading)
    everyone = tuple(sorted({owner[p] for p in range(b, e) if owner[p] >= 0}))
    if m is None:
        return [(b, key, everyone) for key in mora_keys(reading)]
    out: list[tuple[int, str, tuple[int, ...]]] = []
    for g, (kind, a, z) in enumerate(parts):
        group = m.group(g + 1)
        keys = mora_keys(group)
        if kind == "kanji":
            run = tuple(sorted({owner[p] for p in range(a, z) if owner[p] >= 0}))
            out.extend((a, key, run) for key in keys)
        else:
            for (ma, mz), key in zip(mora_spans(group), keys):
                out.append((a + ma, key, tuple(sorted({owner[a + p] for p in range(ma, mz) if owner[a + p] >= 0}))))
    return out


def ja_sequence(text: str) -> tuple[list[Unit], list[tuple[str, tuple[int, ...]]]]:
    """Units of ``text`` and its comparison sequence: (key, indexes of the units that own it)."""
    cleaned, units, spans = ja_units(text)
    owner = [-1] * len(cleaned)
    for k, (a, z) in enumerate(spans):
        for p in range(a, z):
            owner[p] = k
    entries: list[tuple[int, int, str, tuple[int, ...]]] = []
    covered = [False] * len(units)
    word_parts: dict[int, list[str] | None] = {}
    tok = _sudachi()
    morphemes = [] if tok is None else [(m.begin(), m.end(), m.reading_form(), m.is_oov()) for m in tok.tokenize(cleaned)]
    for b, e, reading, oov in morphemes:
        owners = {owner[p] for p in range(b, e) if owner[p] >= 0}
        if not owners:
            continue  # a space
        words = {k for k in owners if units[k].kind == "word"}
        for k in words:  # a Latin word is compared by its dictionary reading when it has one (dance = ダンス)
            usable = not oov and owners == {k} and _all_katakana(reading) and word_parts.get(k, []) is not None
            word_parts[k] = (word_parts.get(k) or []) + mora_keys(reading) if usable else None
        if words:
            continue
        kata = to_katakana(reading)
        if not _all_katakana(kata):
            continue  # no reading: these units keep their own keys
        for pos, key, who in _distribute(cleaned, owner, b, e, kata):
            entries.append((pos, len(entries), key, who))
        for k in owners:
            covered[k] = True
    for k, unit in enumerate(units):
        if unit.kind == "word":
            keys = word_parts.get(k) or [word_key(unit.text)]
        elif covered[k]:
            continue
        else:
            keys = _own_keys(unit)
        for key in keys:
            entries.append((spans[k][0], len(entries), key, (k,)))
    entries.sort(key=lambda t: (t[0], t[1]))
    return units, [(key, who) for _, _, key, who in entries]


def is_filler_kana(text: str) -> bool:
    base = "".join(c for c in text if c not in ATTACH)
    return len(base) == 1 and base in _FILLER_BASES
