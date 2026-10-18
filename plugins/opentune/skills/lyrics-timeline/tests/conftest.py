# SPDX-License-Identifier: MIT
"""Shared fixtures: a synthetic sung vocal, built with numpy only (no audio files in the repo)."""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

from lytl.backends import FakeAligner, FakeAsr, TruthToken  # noqa: E402

SR = 16000

SONG = [
    "月光洒在窗台上",
    "我想起你的模样",
    "我爱你有多深",
    "月亮代表我的心",
    "星光照亮回家路",
    "我在原地等着你",
    "我爱你有多深",
    "月亮代表我的心",
]
CHAR_SEC = 0.35
CHAR_GAP = 0.05
LINE_GAP = 1.0


def build_truth(lines: list[str] = SONG, start: float = 1.0) -> list[TruthToken]:
    truth: list[TruthToken] = []
    t = start
    for line in lines:
        for ch in line:
            truth.append(TruthToken(ch, round(t, 3), round(t + CHAR_SEC, 3)))
            t += CHAR_SEC + CHAR_GAP
        t += LINE_GAP - CHAR_GAP
    return truth


def synth_vocal(
    truth: list[TruthToken], extra_tail: float = 1.5, noise: float = 0.0005, duration: float | None = None
) -> np.ndarray:
    """Pitched bursts at the scripted times over a very quiet noise floor (``duration`` fixes the length)."""
    n = int((duration if duration is not None else truth[-1].end + extra_tail) * SR)
    rng = np.random.default_rng(7)
    x = rng.normal(0, noise, n).astype(np.float32)
    t_all = np.arange(n) / SR
    for k, tok in enumerate(truth):
        a, b = int(tok.start * SR), int(tok.end * SR)
        f0 = 200.0 + 15.0 * (k % 6)
        t = t_all[a:b] - tok.start
        wave = sum(np.sin(2 * np.pi * f0 * h * t) / h for h in (1, 2, 3))
        env = np.minimum(1.0, t / 0.012) * np.minimum(1.0, (tok.end - tok.start - t) / 0.03)
        x[a:b] += (0.25 * env * wave / 1.8).astype(np.float32)
    return x


@pytest.fixture(scope="session")
def truth() -> list[TruthToken]:
    return build_truth()


@pytest.fixture(scope="session")
def vocal(truth: list[TruthToken]) -> np.ndarray:
    return synth_vocal(truth)


@pytest.fixture()
def backends(truth: list[TruthToken]):
    return FakeAsr(truth), FakeAligner(truth)


LYRICS = """[Verse 1]
月光洒在窗台上
我想起你的模样

[Chorus]
我爱你有多深
月亮代表我的心

[Verse 2]
星光照亮回家路
我在原地等着你

[Chorus]
"""
