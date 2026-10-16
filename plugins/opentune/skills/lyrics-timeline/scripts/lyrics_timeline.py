# SPDX-License-Identifier: MIT
"""Command line entry: vocal WAV (+ optional lyrics and notes) -> word-level timeline JSON."""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lytl import home as lhome  # noqa: E402
from lytl.audio import TARGET_SR, load_audio, resample  # noqa: E402
from lytl.pipeline import build_timeline  # noqa: E402
from lytl.schema import validate_output  # noqa: E402
from lytl.snap import DEFAULT_SNAP_WINDOW, parse_notes  # noqa: E402


def _read_lyrics(arg: str | None) -> str | None:
    if not arg:
        return None
    try:
        if os.path.isfile(arg):
            with open(arg, encoding="utf-8-sig") as fh:
                return fh.read()
    except OSError:
        pass
    return arg


def _read_json(path: str) -> object:
    with open(path, encoding="utf-8-sig") as fh:
        return json.load(fh)


def _fake_backends(path: str):
    from lytl.backends import FakeAligner, FakeAsr, TruthToken

    spec = _read_json(path)
    tokens = spec["tokens"] if isinstance(spec, dict) else spec
    truth = [TruthToken(t["text"], float(t["start"]), float(t["end"])) for t in tokens]
    extra = spec if isinstance(spec, dict) else {}
    return FakeAsr(truth, extra.get("substitutions"), extra.get("drop", ())), FakeAligner(truth)


def _qwen_backends(size: str, device: str | None):
    from lytl.backends import QwenAligner, QwenAsr

    home = lhome.data_home()
    if size == "auto":
        size = lhome.selected_size(home) or ("1.7B" if lhome.has_nvidia_gpu() else "0.6B")
    asr_dir = lhome.model_dir(lhome.ASR_REPOS[size], home)
    aligner_dir = lhome.model_dir(lhome.ALIGNER_REPO, home)
    for d in (asr_dir, aligner_dir):
        if not os.path.isdir(d):
            raise SystemExit(
                f"model folder not found: {d}\nRun scripts/setup.py first (it asks for confirmation "
                "with --yes after showing the download size with --plan)."
            )
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    return QwenAsr(asr_dir, device), QwenAligner(aligner_dir, device)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Word-level lyrics timeline for a vocal WAV file.")
    ap.add_argument("audio", help="vocal WAV file")
    ap.add_argument("--lyrics", help="lyrics text, or a path to a text / LRC file")
    ap.add_argument("--notes", help="JSON from opentune_get_notes (content clock) for snapping and splitting")
    ap.add_argument("--language", choices=["zh", "en", "auto"], default="auto")
    ap.add_argument("--out", help="write the JSON here (default: standard output)")
    ap.add_argument("--backend", choices=["qwen", "fake"], default="qwen")
    ap.add_argument("--fake-truth", help="JSON script for --backend fake (testing only)")
    ap.add_argument("--model-size", choices=["auto", "0.6B", "1.7B"], default="auto")
    ap.add_argument("--device", help="torch device, for example cpu or cuda:0 (default: automatic)")
    ap.add_argument("--snap-window", type=float, default=DEFAULT_SNAP_WINDOW, help="seconds either side of a token start")
    args = ap.parse_args(argv)

    x, sr = load_audio(args.audio)
    x16 = resample(x, sr, TARGET_SR)
    notes = parse_notes(_read_json(args.notes)) if args.notes else []
    lyrics = _read_lyrics(args.lyrics)
    if args.backend == "fake":
        if not args.fake_truth:
            ap.error("--backend fake needs --fake-truth")
        asr, aligner = _fake_backends(args.fake_truth)
        info = {"asr": asr.name, "aligner": aligner.name}
    else:
        asr, aligner = _qwen_backends(args.model_size, args.device)
        info = {"asr": asr.name, "aligner": aligner.name}
    doc = build_timeline(
        x16,
        asr,
        aligner,
        lyrics=lyrics,
        notes=notes,
        language=args.language,
        snap_window=args.snap_window,
        audio_name=os.path.basename(args.audio),
        sample_rate=sr,
        model_info=info,
    )
    problems = validate_output(doc)
    if problems:
        print("warning: output failed its own structure check: " + "; ".join(problems[:5]), file=sys.stderr)
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text + "\n")
        print(f"wrote {args.out}: {len(doc['lines'])} lines, {len(doc['sections'])} sections", file=sys.stderr)
    else:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
