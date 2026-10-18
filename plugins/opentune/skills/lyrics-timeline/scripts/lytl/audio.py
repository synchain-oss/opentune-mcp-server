# SPDX-License-Identifier: MIT
"""Audio reading, frame features, energy/F0 voice activity, chunking, onsets and breaths.

Everything here works on a dry vocal, where silence is real silence. No model is involved.
"""

from __future__ import annotations

import wave
from dataclasses import dataclass

import numpy as np

TARGET_SR = 16000
HOP_SEC = 0.01
WIN_SEC = 0.025
MAX_ASR_SEC = 30.0
MAX_ALIGN_SEC = 280.0


def load_audio(path: str) -> tuple[np.ndarray, int]:
    """Read a WAV file as mono float32 plus its sample rate."""
    try:
        import soundfile as sf  # type: ignore[import-not-found]

        data, sr = sf.read(path, dtype="float32", always_2d=True)
        return data.mean(axis=1).astype(np.float32), int(sr)
    except ImportError:
        pass
    with wave.open(path, "rb") as wf:
        sr, ch, width = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        x = v.astype(np.float32) / 8388608.0
    else:
        raise ValueError(f"unsupported sample width {width} bytes; install soundfile for this file")
    return x.reshape(-1, ch).mean(axis=1).astype(np.float32), sr


def resample(x: np.ndarray, sr: int, target: int = TARGET_SR) -> np.ndarray:
    if sr == target or x.size == 0:
        return x.astype(np.float32)
    try:
        from math import gcd

        from scipy.signal import resample_poly  # type: ignore[import-not-found]

        g = gcd(sr, target)
        return resample_poly(x, target // g, sr // g).astype(np.float32)
    except ImportError:
        # Fallback without scipy: smooth by a moving average, then interpolate linearly.
        if sr > target:
            k = max(1, int(round(sr / target)))
            x = np.convolve(x, np.ones(k, dtype=np.float32) / k, mode="same")
        n = int(round(x.size * target / sr))
        return np.interp(np.linspace(0, x.size - 1, n), np.arange(x.size), x).astype(np.float32)


@dataclass
class Features:
    hop: float
    rms_db: np.ndarray
    voiced: np.ndarray  # bool per frame
    f0: np.ndarray  # Hz, 0 where unvoiced
    duration: float

    @property
    def n(self) -> int:
        return int(self.rms_db.size)

    def t(self, frame: int) -> float:
        return frame * self.hop

    def frame_at(self, t: float) -> int:
        return int(min(max(round(t / self.hop), 0), max(self.n - 1, 0)))


def frame_features(x: np.ndarray, sr: int = TARGET_SR) -> Features:
    """Per 10 ms frame: RMS in dB, a voicing decision and F0 from normalised autocorrelation."""
    hop = int(round(HOP_SEC * sr))
    win = int(round(WIN_SEC * sr))
    duration = x.size / sr
    if x.size < win:
        return Features(HOP_SEC, np.full(1, -120.0), np.zeros(1, bool), np.zeros(1), duration)
    n = 1 + (x.size - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = x[idx].astype(np.float64)
    rms = np.sqrt((frames**2).mean(axis=1) + 1e-14)
    rms_db = 20 * np.log10(rms)
    # Normalised autocorrelation through the FFT, searching 60-800 Hz.
    frames = frames - frames.mean(axis=1, keepdims=True)
    size = 1 << (2 * win - 1).bit_length()
    spec = np.fft.rfft(frames * np.hanning(win), size, axis=1)
    ac = np.fft.irfft(spec * np.conj(spec), size, axis=1)[:, :win]
    ac = ac / (ac[:, :1] + 1e-12)
    lo, hi = int(sr / 800), min(int(sr / 60), win - 1)
    seg = ac[:, lo:hi]
    peak = seg.argmax(axis=1)
    strength = seg.max(axis=1)
    floor_db = np.percentile(rms_db, 10)
    loud = rms_db > max(floor_db + 10.0, rms_db.max() - 45.0)
    voiced = (strength > 0.45) & loud
    f0 = np.where(voiced, sr / (peak + lo), 0.0)
    return Features(HOP_SEC, rms_db, voiced, f0, duration)


def speech_threshold(f: Features) -> float:
    floor_db = float(np.percentile(f.rms_db, 10))
    peak_db = float(np.percentile(f.rms_db, 95))
    return max(floor_db + 10.0, peak_db - 28.0)


def energy_vad(f: Features, min_dur: float = 0.12, merge_gap: float = 0.35) -> list[tuple[float, float]]:
    """Speech regions: frames above the threshold, bridged over short gaps, short blips dropped."""
    active = f.rms_db > speech_threshold(f)
    regions: list[list[int]] = []
    start = None
    for i, a in enumerate(np.append(active, False)):
        if a and start is None:
            start = i
        elif not a and start is not None:
            regions.append([start, i])
            start = None
    merged: list[list[int]] = []
    for r in regions:
        if merged and (r[0] - merged[-1][1]) * f.hop < merge_gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a * f.hop, b * f.hop) for a, b in merged if (b - a) * f.hop >= min_dur]


def split_chunks(
    regions: list[tuple[float, float]],
    f: Features,
    max_len: float = MAX_ASR_SEC,
    gap_break: float = 0.8,
) -> list[tuple[float, float]]:
    """Group speech regions into chunks of at most ``max_len`` seconds, breaking at long gaps first."""
    chunks: list[list[float]] = []
    for a, b in regions:
        if chunks and a - chunks[-1][1] < gap_break and b - chunks[-1][0] <= max_len:
            chunks[-1][1] = b
        else:
            chunks.append([a, b])
    out: list[tuple[float, float]] = []
    for a, b in chunks:
        while b - a > max_len:  # one unbroken stretch: cut at the quietest frame near the limit
            lo, hi = f.frame_at(a + max_len * 0.6), f.frame_at(a + max_len)
            cut = lo + int(np.argmin(f.rms_db[lo : hi + 1]))
            out.append((a, cut * f.hop))
            a = cut * f.hop
        out.append((a, b))
    return out


def group_windows(chunks: list[tuple[float, float]], max_len: float = MAX_ALIGN_SEC) -> list[list[int]]:
    """Group consecutive chunk indexes into alignment windows of at most ``max_len`` seconds."""
    groups: list[list[int]] = []
    for i, (a, b) in enumerate(chunks):
        if groups and b - chunks[groups[-1][0]][0] <= max_len:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def detect_onsets(f: Features, rise_db: float = 6.0, min_sep: float = 0.06) -> list[float]:
    """Acoustic onsets: sharp rises of the level, and unvoiced-to-voiced transitions above the gate."""
    if f.n < 4:
        return []
    gate = speech_threshold(f) - 6.0
    rise = f.rms_db[2:] - f.rms_db[:-2]
    cand = set()
    for i in np.nonzero((rise > rise_db) & (f.rms_db[2:] > gate))[0]:
        j = i + 2
        while j > 0 and f.rms_db[j - 1] <= f.rms_db[j]:  # walk back to the foot of the rise
            j -= 1
            if f.rms_db[j] < gate - 6.0:
                break
        cand.add(j)
    v = f.voiced
    for i in np.nonzero(v[1:] & ~v[:-1])[0]:
        cand.add(int(i) + 1)
    out: list[float] = []
    for j in sorted(cand):
        t = j * f.hop
        if not out or t - out[-1] >= min_sep:
            out.append(t)
    return out


def voiced_start(start: float, end: float, f: Features, min_frames: int = 3) -> float:
    """First time in [start, end] where the voice is pitched for ``min_frames`` frames in a row."""
    a, b = f.frame_at(start), f.frame_at(end)
    run = 0
    for i in range(a, min(b, f.n - 1) + 1):
        run = run + 1 if f.voiced[i] else 0
        if run >= min_frames:
            return float((i - min_frames + 1) * f.hop)
    return float(start)


def voiced_ratio(start: float, end: float, f: Features) -> float:
    a, b = f.frame_at(start), f.frame_at(end)
    if b <= a:
        return 0.0
    return float(f.voiced[a:b].mean())


def detect_breaths(
    f: Features,
    regions: list[tuple[float, float]],
    min_dur: float = 0.15,
    max_dur: float = 1.5,
) -> list[tuple[float, float]]:
    """Quiet unpitched noise bursts in the gaps between sung regions."""
    floor_db = float(np.percentile(f.rms_db, 10))
    thr = speech_threshold(f)
    gate = floor_db + 8.0
    bounds = [(0.0, regions[0][0])] if regions else []
    bounds += [(regions[i][1], regions[i + 1][0]) for i in range(len(regions) - 1)]
    if regions:
        bounds.append((regions[-1][1], f.duration))
    out: list[tuple[float, float]] = []
    for ga, gb in bounds:
        a, b = f.frame_at(ga), f.frame_at(gb)
        seg = (f.rms_db[a:b] > gate) & (f.rms_db[a:b] < thr) & ~f.voiced[a:b]
        start = None
        for k, on in enumerate(np.append(seg, False)):
            if on and start is None:
                start = k
            elif not on and start is not None:
                dur = (k - start) * f.hop
                if min_dur <= dur <= max_dur:
                    out.append(((a + start) * f.hop, (a + k) * f.hop))
                start = None
    return out
