# SPDX-License-Identifier: MIT
"""Languages: which ones the models handle, and which one a song is in.

The forced aligner decides what can be timed. Its language list comes from the model itself
(``support_languages`` in Qwen3-ForcedAligner-0.6B's config.json at the pinned revision; the model
card lists the same eleven). The recogniser knows more languages (``SUPPORTED_LANGUAGES`` in
qwen_asr/inference/utils.py of qwen-asr 0.0.6); a song in one of those can be recognised but not
timed, which is reported as an error that lists the supported codes.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from typing import Iterable

# Code -> the name the qwen-asr package uses for it.
ALIGNER_LANGUAGES = {
    "zh": "Chinese",
    "yue": "Cantonese",
    "en": "English",
    "de": "German",
    "es": "Spanish",
    "fr": "French",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ko": "Korean",
    "ja": "Japanese",
}
# Recognised by Qwen3-ASR but not supported by the aligner.
ASR_ONLY_LANGUAGES = {
    "ar": "Arabic",
    "id": "Indonesian",
    "th": "Thai",
    "vi": "Vietnamese",
    "tr": "Turkish",
    "hi": "Hindi",
    "ms": "Malay",
    "nl": "Dutch",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "pl": "Polish",
    "cs": "Czech",
    "fil": "Filipino",
    "fa": "Persian",
    "el": "Greek",
    "ro": "Romanian",
    "hu": "Hungarian",
    "mk": "Macedonian",
}
ASR_LANGUAGES = {**ALIGNER_LANGUAGES, **ASR_ONLY_LANGUAGES}
# Supported languages written in Latin script; a Latin-script line in another song is aligned as one of these.
LATIN_LANGUAGES = ("en", "de", "es", "fr", "it", "pt")
# A non-Latin script found in lyrics -> the language it is taken for.
_SCRIPT_LANGUAGE = {
    "kana": "ja",
    "hangul": "ko",
    "han": "zh",
    "cyrillic": "ru",
    "thai": "th",
    "arabic": "ar",
    "greek": "el",
    "devanagari": "hi",
}
SUPPORTED_TEXT = ", ".join(f"{c} ({n})" for c, n in ALIGNER_LANGUAGES.items())


class UnsupportedLanguage(ValueError):
    """A language that the aligner cannot time (or an unknown code)."""


def code_from_name(name: str | None) -> str | None:
    """The code for a qwen-asr language name such as "Japanese" or "Chinese,English" (first one)."""
    if not name:
        return None
    first = str(name).split(",")[0].strip().lower()
    for code, full in ASR_LANGUAGES.items():
        if full.lower() == first or code == first:
            return code
    return None


def check_language(code: str) -> str:
    """Return ``code`` when the aligner supports it; otherwise raise UnsupportedLanguage."""
    if code in ALIGNER_LANGUAGES:
        return code
    if code in ASR_ONLY_LANGUAGES:
        raise UnsupportedLanguage(
            f"{ASR_ONLY_LANGUAGES[code]} ({code}) can be recognised but the forced aligner cannot time it; "
            f"supported languages: {SUPPORTED_TEXT}"
        )
    raise UnsupportedLanguage(f"unknown language code {code!r}; supported languages: {SUPPORTED_TEXT}, or auto")


def is_kana(ch: str) -> bool:
    cp = ord(ch)
    return 0x3041 <= cp <= 0x309F or 0x30A0 <= cp <= 0x30FF or 0x31F0 <= cp <= 0x31FF or 0xFF66 <= cp <= 0xFF9F


def is_hangul(ch: str) -> bool:
    cp = ord(ch)
    return 0xAC00 <= cp <= 0xD7A3 or 0x1100 <= cp <= 0x11FF or 0x3130 <= cp <= 0x318F


def is_han(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0x20000 <= cp <= 0x2A6DF
        or 0xF900 <= cp <= 0xFAFF
        or ch in "々〆〇"
    )


def script_of(ch: str) -> str | None:
    """The script of one letter (None for anything that is not a letter)."""
    if not ch.isalpha():
        return None
    if is_kana(ch):
        return "kana"
    if is_hangul(ch):
        return "hangul"
    if is_han(ch):
        return "han"
    cp = ord(ch)
    if 0x0400 <= cp <= 0x052F:
        return "cyrillic"
    if 0x0E00 <= cp <= 0x0E7F:
        return "thai"
    if 0x0600 <= cp <= 0x06FF or 0x0750 <= cp <= 0x077F:
        return "arabic"
    if 0x0370 <= cp <= 0x03FF:
        return "greek"
    if 0x0900 <= cp <= 0x097F:
        return "devanagari"
    if cp < 0x0250 or 0x1E00 <= cp <= 0x1EFF:
        return "latin"
    return "other"


def script_language(text: str) -> str | None:
    """The language the writing of ``text`` points to.

    Returns "ja" (any real share of kana), "ko" (hangul), "zh" (Chinese characters only), "ru"
    (Cyrillic), the code of another non-Latin script ("th", "ar", "el", "hi"), "other" for a
    non-Latin script none of the models knows, "latin" when Latin letters dominate, or None when
    there are no letters. Non-Latin letters win when they make up at least a third of all letters
    (one Chinese character weighs about as much as a short English word).
    """
    counts = Counter(s for s in (script_of(c) for c in unicodedata.normalize("NFKC", text)) if s)
    latin = counts.pop("latin", 0)
    nonlatin = sum(counts.values())
    if nonlatin == 0 or nonlatin * 3 < nonlatin + latin:
        return "latin" if latin else None
    kana, han = counts.get("kana", 0), counts.get("han", 0)
    if kana and kana * 10 >= kana + han:  # kanji-heavy Japanese still has a tenth of kana
        return "ja"
    best = max(counts, key=lambda s: (counts[s], s == "han"))
    return _SCRIPT_LANGUAGE.get(best, "other")


def majority(codes: Iterable[tuple[str | None, int]]) -> str | None:
    """The code with the largest weight (weights are lengths of recognised text)."""
    total: Counter[str] = Counter()
    for code, weight in codes:
        if code:
            total[code] += max(weight, 1)
    return total.most_common(1)[0][0] if total else None


def asr_language_for(requested: str, lyrics: str | None) -> str:
    """The language to force on the recogniser ("auto" lets it decide)."""
    if requested != "auto":
        return requested
    if lyrics:
        script = script_language(lyrics)
        if script in ("ja", "ko", "zh", "ru"):
            return script
    return "auto"


def precheck(requested: str, lyrics: str | None) -> None:
    """Raise UnsupportedLanguage before any model is loaded, when the outcome is already certain."""
    if requested != "auto":
        check_language(requested)
        return
    if lyrics:
        script = script_language(lyrics)
        if script == "other":
            raise UnsupportedLanguage(
                f"the lyrics are written in a script that the forced aligner does not support; supported languages: {SUPPORTED_TEXT}"
            )
        if script not in (None, "latin"):
            check_language(script)


def decide_language(
    requested: str,
    lyrics: str | None,
    reported: Iterable[tuple[str | None, int]],
    heard_text: str,
) -> tuple[str, str, list[str]]:
    """(language, source, warnings). Source is "user", "lyrics" or "asr".

    With lyrics, their writing decides (the recogniser's guess is unreliable on singing); only for
    Latin-script lyrics, where the writing cannot tell English from French, the recogniser's report
    picks among the supported Latin-script languages. Without lyrics, the recogniser's own report
    comes first and the writing of what it heard second. A reported language that only the
    recogniser knows falls back to English when what it heard is in Latin letters (as with lyrics)
    and is an error otherwise.
    """
    warnings: list[str] = []
    if requested != "auto":
        return check_language(requested), "user", warnings
    reported = list(reported)
    rep = majority(reported)
    script = script_language(lyrics) if lyrics else None
    if script is not None:
        precheck("auto", lyrics)
        if script != "latin":
            return script, "lyrics", warnings
        if rep in LATIN_LANGUAGES:
            return rep, "asr", warnings
        if rep in ASR_ONLY_LANGUAGES:
            warnings.append(
                f"the recogniser reported {ASR_ONLY_LANGUAGES[rep]}, which the forced aligner does not support; "
                "the lyrics were aligned as English (word by word). Pass --language to choose another supported language."
            )
        return "en", "lyrics", warnings
    heard_script = script_language(heard_text)
    if rep in ALIGNER_LANGUAGES:
        return rep, "asr", warnings
    if rep is not None:
        name = f"{ASR_LANGUAGES.get(rep, rep)} ({rep})"
        if heard_script == "latin":
            warnings.append(
                f"the recogniser reported {name}, which the forced aligner does not support; what it heard was "
                "aligned as English (word by word). Pass --language to choose another supported language."
            )
            return "en", "asr", warnings
        raise UnsupportedLanguage(
            f"the recogniser reported {name}, which the forced aligner cannot time; supported languages: "
            f"{SUPPORTED_TEXT}. If the song is in one of them, run again with --language and its code."
        )
    if heard_script in (None, "latin"):
        return "en", "asr", warnings
    if heard_script == "other":
        raise UnsupportedLanguage(f"the recognised text is in a script the forced aligner does not support; supported languages: {SUPPORTED_TEXT}")
    return check_language(heard_script), "asr", warnings


def line_language(texts: Iterable[str], song: str) -> str:
    """The language to hand the aligner for one line: a Latin-only line of a non-Latin song is English."""
    if song in LATIN_LANGUAGES:
        return song
    for t in texts:
        if any(script_of(c) not in (None, "latin") for c in t):
            return song
    return "en"
