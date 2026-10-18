# SPDX-License-Identifier: MIT
"""Recogniser and aligner back ends.

``AsrBackend`` turns a stretch of audio into text; ``AlignerBackend`` gives start and end times
for given text units inside a window. Real implementations wrap Qwen3-ASR and
Qwen3-ForcedAligner (Apache-2.0 code and weights); the fakes generate results from a script so
the pipeline can be tested without a model.
"""

from __future__ import annotations

import os
import unicodedata
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from .langs import ALIGNER_LANGUAGES, ASR_LANGUAGES, code_from_name, is_han, is_kana
from .normalize import Unit, tokenize, units_text

# Licences that rule a model out; kept here so a later contributor does not add one by accident.
EXCLUDED_MODELS = (
    "MMS (CC-BY-NC)",
    "SOFA / HubertFA / SingAlign weights (non-commercial)",
    "whisper-timestamped (AGPL)",
    "SongPrep (academic only)",
    "SongFormer (non-commercial dependency)",
    "TEN VAD (extra conditions)",
)


class AsrBackend(ABC):
    name = "asr"
    # Set by ``transcribe``: the language code the recogniser reported for that call, or None.
    last_language: str | None = None

    @abstractmethod
    def transcribe(self, audio: np.ndarray, start: float, end: float, language: str) -> str:
        """Text sung in ``audio`` (16 kHz mono, the slice that begins at ``start`` seconds).

        ``language`` is a code from langs.ASR_LANGUAGES, or "auto" to let the recogniser decide.
        """

    def start_track(self, index: int) -> None:
        """Called before each audio file of a run; the real back ends keep nothing per file."""


class AlignerBackend(ABC):
    name = "aligner"
    # Set by ``align``: (spans the model returned, units asked for) when the two differed and the
    # spans were resampled onto the units; None after a call whose counts matched.
    last_mismatch: tuple[int, int] | None = None

    def start_track(self, index: int) -> None:
        """Called before each audio file of a run; the real back ends keep nothing per file."""

    @abstractmethod
    def align(
        self, audio: np.ndarray, start: float, end: float, units: Sequence[Unit], language: str
    ) -> list[tuple[float, float]]:
        """One (start, end) per unit in absolute seconds; ``audio`` begins at ``start``."""


# ---------------------------------------------------------------------------------------------
# Test back ends


@dataclass(frozen=True)
class TruthToken:
    text: str
    start: float
    end: float


def _joins_without_space(text: str) -> bool:
    return bool(text) and all(is_han(c) or is_kana(c) for c in text)


class FakeAsr(AsrBackend):
    """Hears the scripted tokens that lie inside the window, with optional errors.

    ``substitutions`` maps a scripted token to what is heard instead (it may be several units:
    君 -> きみ); ``reported_language`` is the language code it claims to hear when not told one.
    ``tracks`` gives one script per audio file of a multi-track run (``start_track`` picks one).
    """

    name = "fake-asr"

    def __init__(
        self,
        truth: Sequence[TruthToken],
        substitutions: dict[str, str] | None = None,
        drop: Sequence[str] = (),
        reported_language: str | None = None,
        tracks: Sequence[Sequence[TruthToken]] | None = None,
    ) -> None:
        self.truth = list(truth)
        self.substitutions = substitutions or {}
        self.drop = set(drop)
        self.reported_language = reported_language
        self.tracks = [list(t) for t in tracks] if tracks is not None else None

    def start_track(self, index: int) -> None:
        if self.tracks is not None:
            self.truth = self.tracks[index]

    def transcribe(self, audio: np.ndarray, start: float, end: float, language: str) -> str:
        heard = [t for t in self.truth if t.start >= start - 1e-6 and t.end <= end + 1e-6]
        words = [self.substitutions.get(t.text, t.text) for t in heard if t.text not in self.drop]
        self.last_language = self.reported_language if language == "auto" else language
        out = ""
        for w in words:  # Chinese characters and kana run together; words are separated by spaces
            if out and _joins_without_space(w) and _joins_without_space(out[-1]):
                out += w
            else:
                out += (" " if out else "") + w
        return out


class FakeAligner(AlignerBackend):
    """Looks the units up in the scripted tokens of the window; spreads them evenly otherwise.

    A scripted token matches the units of its own text, or of its rendition in ``renditions`` (the
    FakeAsr substitutions); a token heard as several units shares its time evenly among them.
    """

    name = "fake-aligner"

    def __init__(
        self,
        truth: Sequence[TruthToken] | None = None,
        noise: float = 0.0,
        renditions: dict[str, str] | None = None,
        tracks: Sequence[Sequence[TruthToken]] | None = None,
    ) -> None:
        self.truth = list(truth or [])
        self.noise = noise
        self.renditions = renditions or {}
        self.tracks = [list(t) for t in tracks] if tracks is not None else None

    def start_track(self, index: int) -> None:
        if self.tracks is not None:
            self.truth = self.tracks[index]

    def _forms(self, token: TruthToken, language: str) -> list[list[str]]:
        forms = [[u.text for u in tokenize(token.text, language)]]
        if token.text in self.renditions:
            forms.append([u.text for u in tokenize(self.renditions[token.text], language)])
        return [f for f in forms if f]

    def align(
        self, audio: np.ndarray, start: float, end: float, units: Sequence[Unit], language: str
    ) -> list[tuple[float, float]]:
        pool = [t for t in self.truth if t.start >= start - 1e-6 and t.end <= end + 1e-6]
        forms = [self._forms(t, language) for t in pool]
        texts = [u.text for u in units]
        out: list[tuple[float, float] | None] = [None] * len(units)

        def form_at(c: int, i: int) -> list[str] | None:
            return next((f for f in forms[c] if texts[i : i + len(f)] == f), None)

        def resumes_at(i: int) -> int | None:
            """The next scripted token from which two units in a row match again (or the last unit)."""
            for c in range(cursor + 2, len(pool)):
                f = form_at(c, i)
                if f is not None and (i + len(f) >= len(units) or (c + 1 < len(pool) and form_at(c + 1, i + len(f)))):
                    return c
            return None

        i = cursor = 0
        while i < len(units) and cursor < len(pool):
            form = form_at(cursor, i)
            if form is None and cursor + 1 < len(pool) and form_at(cursor + 1, i) is not None:
                cursor += 1  # the recogniser dropped one scripted token
                continue
            if form is None and (c := resumes_at(i)) is not None:
                cursor = c  # it heard nothing of a longer stretch (a whole line)
                continue
            # A different text at the cursor is a misrecognition: it still sits at that time.
            k = len(form) if form else 1
            tok = pool[cursor]
            step = (tok.end - tok.start) / k
            for q in range(k):
                out[i + q] = (tok.start + q * step + self.noise, tok.start + (q + 1) * step + self.noise)
            i += k
            cursor += 1
        # Fill each run of unmatched units by even spacing between its known neighbours.
        i = 0
        while i < len(units):
            if out[i] is not None:
                i += 1
                continue
            j = i
            while j < len(units) and out[j] is None:
                j += 1
            lo = out[i - 1][1] if i > 0 else start  # type: ignore[index]
            hi = out[j][0] if j < len(units) else end  # type: ignore[index]
            step = max(hi - lo, 0.0) / (j - i)
            for k in range(i, j):
                out[k] = (lo + (k - i) * step, lo + (k - i + 1) * step)
            i = j
        return [t for t in out if t is not None]


# ---------------------------------------------------------------------------------------------
# Real back ends (not exercised by the tests: they need torch and the model weights)

# qwen-asr 0.0.6 uses the aligner's language only to split the text into timed units
# (Qwen3ForceAlignProcessor.encode_timestamp in qwen_asr/inference/qwen3_forced_aligner.py, lines
# 236-252): nagisa words for "Japanese", soynlp words for "Korean", and for every other name the
# text split at spaces with each Chinese character on its own. soynlp is GPL-3.0 and is not
# installed, so Korean is sent under a name that selects the space splitter: one unit per word.
_WHITESPACE_SPLITTER = "English"


def aligner_language_name(code: str) -> str:
    if code == "ko":
        return _WHITESPACE_SPLITTER
    return ALIGNER_LANGUAGES.get(code, _WHITESPACE_SPLITTER)


def _kept(text: str) -> str:
    """The characters the aligner keeps of a unit (letters, digits and the apostrophe)."""
    return "".join(c for c in text if c == "'" or unicodedata.category(c)[0] in "LN")


def project_items(items: Sequence[Any], units: Sequence[Unit]) -> list[tuple[float, float]] | None:
    """Spans (relative to the window) for ``units`` from the aligner's items, matched by text.

    The aligner may cut the text differently from our units (nagisa words for Japanese). As long as
    both sides spell the same characters, each item's time is shared evenly among its characters
    and every unit gets the span of its own characters. None when the characters differ.
    """
    unit_chars = [_kept(u.text) for u in units]
    item_texts = [getattr(it, "text", None) for it in items]
    if not items or any(t is None for t in item_texts) or any(not c for c in unit_chars):
        return None
    if "".join(unit_chars) != "".join(_kept(str(t)) for t in item_texts):
        return None
    char_spans: list[tuple[float, float]] = []
    for it, text in zip(items, item_texts):
        n = len(_kept(str(text)))
        s, e = float(it.start_time), float(it.end_time)
        char_spans.extend((s + (e - s) * k / n, s + (e - s) * (k + 1) / n) for k in range(n))
    out = []
    pos = 0
    for chars in unit_chars:
        out.append((char_spans[pos][0], char_spans[pos + len(chars) - 1][1]))
        pos += len(chars)
    return out


def model_dir_name(repo: str) -> str:
    return repo.split("/")[-1]


class QwenAsr(AsrBackend):
    """Qwen3-ASR through the ``qwen-asr`` package, loaded from a local directory."""

    def __init__(self, model_path: str, device: str | None = None) -> None:
        import torch  # type: ignore[import-not-found]
        from qwen_asr import Qwen3ASRModel  # type: ignore[import-not-found]

        self.name = "Qwen3-ASR:" + os.path.basename(model_path.rstrip("/\\"))
        use_cuda = (device or ("cuda:0" if torch.cuda.is_available() else "cpu")).startswith("cuda")
        self.model = Qwen3ASRModel.from_pretrained(
            model_path,
            dtype=torch.bfloat16 if use_cuda else torch.float32,
            device_map=device or ("cuda:0" if use_cuda else "cpu"),
            max_inference_batch_size=4,
            max_new_tokens=512,
        )

    def transcribe(self, audio: np.ndarray, start: float, end: float, language: str) -> str:
        lang = ASR_LANGUAGES.get(language)  # None ("auto") lets the model decide
        result = self.model.transcribe(audio=(audio, 16000), language=lang)
        # The model reports the language it heard ("Japanese", or "Chinese,English" for a mix).
        self.last_language = code_from_name(getattr(result[0], "language", None))
        return str(result[0].text)


class QwenAligner(AlignerBackend):
    """Qwen3-ForcedAligner-0.6B through the ``qwen-asr`` package."""

    name = "Qwen3-ForcedAligner-0.6B"

    def __init__(self, model_path: str, device: str | None = None) -> None:
        import torch  # type: ignore[import-not-found]
        from qwen_asr import Qwen3ForcedAligner  # type: ignore[import-not-found]

        use_cuda = (device or ("cuda:0" if torch.cuda.is_available() else "cpu")).startswith("cuda")
        self.model = Qwen3ForcedAligner.from_pretrained(
            model_path,
            dtype=torch.bfloat16 if use_cuda else torch.float32,
            device_map=device or ("cuda:0" if use_cuda else "cpu"),
        )

    def align(
        self, audio: np.ndarray, start: float, end: float, units: Sequence[Unit], language: str
    ) -> list[tuple[float, float]]:
        self.last_mismatch = None
        if not units:
            return []
        text = units_text(list(units))
        items = list(self.model.align(audio=(audio, 16000), text=text, language=aligner_language_name(language))[0])
        projected = project_items(items, units)
        if projected is not None:
            return [(start + a, start + b) for a, b in projected]
        spans = [(start + float(it.start_time), start + float(it.end_time)) for it in items]
        if len(spans) != len(units):
            self.last_mismatch = (len(spans), len(units))
            # The model splits the text by its own rules; resample its spans onto our units.
            spans = _resample_spans(spans, len(units), start, end)
        return spans


def _resample_spans(
    spans: list[tuple[float, float]], n: int, start: float, end: float
) -> list[tuple[float, float]]:
    if not spans:
        step = (end - start) / max(n, 1)
        return [(start + i * step, start + (i + 1) * step) for i in range(n)]
    out = []
    for i in range(n):
        k = min(int(i * len(spans) / n), len(spans) - 1)
        out.append(spans[k])
    return out
