# SPDX-License-Identifier: MIT
"""Recogniser and aligner back ends.

``AsrBackend`` turns a stretch of audio into text; ``AlignerBackend`` gives start and end times
for given text units inside a window. Real implementations wrap Qwen3-ASR and
Qwen3-ForcedAligner (Apache-2.0 code and weights); the fakes generate results from a script so
the pipeline can be tested without a model.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .normalize import Unit, is_cjk, tokenize, units_text

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

    @abstractmethod
    def transcribe(self, audio: np.ndarray, start: float, end: float, language: str) -> str:
        """Text sung in ``audio`` (16 kHz mono, the slice that begins at ``start`` seconds)."""


class AlignerBackend(ABC):
    name = "aligner"

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


class FakeAsr(AsrBackend):
    """Hears the scripted tokens that lie inside the window, with optional errors."""

    name = "fake-asr"

    def __init__(
        self,
        truth: Sequence[TruthToken],
        substitutions: dict[str, str] | None = None,
        drop: Sequence[str] = (),
    ) -> None:
        self.truth = list(truth)
        self.substitutions = substitutions or {}
        self.drop = set(drop)

    def transcribe(self, audio: np.ndarray, start: float, end: float, language: str) -> str:
        heard = [t for t in self.truth if t.start >= start - 1e-6 and t.end <= end + 1e-6]
        words = [self.substitutions.get(t.text, t.text) for t in heard if t.text not in self.drop]
        return units_text(tokenize(" ".join(words), language))


class FakeAligner(AlignerBackend):
    """Looks the units up in the scripted tokens of the window; spreads them evenly otherwise."""

    name = "fake-aligner"

    def __init__(self, truth: Sequence[TruthToken] | None = None, noise: float = 0.0) -> None:
        self.truth = list(truth or [])
        self.noise = noise

    def align(
        self, audio: np.ndarray, start: float, end: float, units: Sequence[Unit], language: str
    ) -> list[tuple[float, float]]:
        pool = [t for t in self.truth if t.start >= start - 1e-6 and t.end <= end + 1e-6]
        out: list[tuple[float, float] | None] = [None] * len(units)
        cursor = 0
        pool_text = [(tokenize(t.text) or [Unit("", "char")])[0].text for t in pool]
        for i, unit in enumerate(units):
            if cursor >= len(pool):
                break
            if pool_text[cursor] != unit.text and cursor + 1 < len(pool) and pool_text[cursor + 1] == unit.text:
                cursor += 1  # the recogniser dropped one scripted token
            # A different text at the cursor is a misrecognition: it still sits at that time.
            out[i] = (pool[cursor].start + self.noise, pool[cursor].end + self.noise)
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

_LANG_NAMES = {"zh": "Chinese", "en": "English"}


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
        lang = _LANG_NAMES.get(language)  # None lets the model decide
        result = self.model.transcribe(audio=(audio, 16000), language=lang)
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
        if not units:
            return []
        text = units_text(list(units))
        lang = _LANG_NAMES.get(language) or ("Chinese" if any(is_cjk(c) for c in text) else "English")
        items = list(self.model.align(audio=(audio, 16000), text=text, language=lang)[0])
        spans = [(start + float(it.start_time), start + float(it.end_time)) for it in items]
        if len(spans) != len(units):
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
