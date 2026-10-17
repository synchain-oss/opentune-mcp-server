# SPDX-License-Identifier: MIT
"""Command line entry: vocal WAV file(s) (+ optional lyrics and notes) -> word-level timeline JSON.

One file gives the single-track result; several files (tracks of one song: lead singers, harmonies)
give one multi-track result that says which lyric line is sung on which track.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lytl import home as lhome  # noqa: E402
from lytl.audio import TARGET_SR, load_audio, resample  # noqa: E402
from lytl.langs import UnsupportedLanguage, precheck  # noqa: E402
from lytl.pipeline import TrackInput, build_multitrack, build_timeline  # noqa: E402
from lytl.schema import validate_output  # noqa: E402
from lytl.snap import DEFAULT_SNAP_WINDOW, Note, merge_notes, parse_notes  # noqa: E402


def _read_lyrics(file: str | None, text: str | None) -> str | None:
    """Lyrics from --lyrics-file (a missing file is an error, never text) or --lyrics-text."""
    if file is not None:
        try:
            with open(file, encoding="utf-8-sig") as fh:
                return fh.read()
        except OSError as exc:
            raise SystemExit(f"error: cannot read --lyrics-file {file!r}: {exc.strerror or exc}") from exc
    return text or None


def _read_notes(paths: list[str] | None) -> list[Note]:
    """Notes from one or more JSON files (each a page of opentune_get_notes or a merged array)."""
    if not paths:
        return []
    pages = []
    for path in paths:
        try:
            pages.append(parse_notes(_read_json(path)))
        except (OSError, ValueError) as exc:
            raise SystemExit(f"error: cannot read --notes file {path!r}: {exc}") from exc
    return merge_notes(pages)


def _read_json(path: str) -> object:
    with open(path, encoding="utf-8-sig") as fh:
        return json.load(fh)


def _fake_backends(path: str, n_tracks: int):
    """Scripted back ends for tests: a token list, {"tokens": [...]}, or {"tracks": [[...], ...]}."""
    from lytl.backends import FakeAligner, FakeAsr, TruthToken

    spec = _read_json(path)
    extra = spec if isinstance(spec, dict) else {}

    def tokens(items):
        return [TruthToken(t["text"], float(t["start"]), float(t["end"])) for t in items]

    tracks = [tokens(t) for t in extra["tracks"]] if "tracks" in extra else None
    if tracks is not None and len(tracks) != n_tracks:
        raise SystemExit(f"error: --fake-truth has {len(tracks)} tracks for {n_tracks} audio files")
    truth = tracks[0] if tracks else tokens(spec["tokens"] if isinstance(spec, dict) else spec)
    subs = extra.get("substitutions")
    asr = FakeAsr(truth, subs, extra.get("drop", ()), extra.get("reported_language"), tracks)
    return asr, FakeAligner(truth, renditions=subs, tracks=tracks)


def _track_labels(values: list[str] | None, audio: list[str]) -> list[str | None]:
    """Labels from --track-label FILE=NAME, matched to the audio arguments (as given, or by file name)."""
    labels: list[str | None] = [None] * len(audio)
    for value in values or []:
        file, sep, name = value.rpartition("=")
        if not sep or not file or not name.strip():
            raise SystemExit(f"error: --track-label needs FILE=NAME, got {value!r}")
        hits = [i for i, a in enumerate(audio) if a == file]
        if not hits:
            hits = [i for i, a in enumerate(audio) if os.path.abspath(a) == os.path.abspath(file)]
        if not hits:
            base = os.path.basename(file).casefold()
            hits = [i for i, a in enumerate(audio) if os.path.basename(a).casefold() == base]
        if len(hits) != 1:
            raise SystemExit(
                f"error: --track-label {value!r} matches {'no' if not hits else 'more than one'} audio file; "
                "give the path exactly as in the audio arguments"
            )
        labels[hits[0]] = name.strip()
    return labels


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
    ap = argparse.ArgumentParser(description="Word-level lyrics timeline for one or more vocal WAV files.")
    ap.add_argument("audio", nargs="+", help="vocal WAV file; several files are tracks of one song")
    lyr = ap.add_mutually_exclusive_group()
    lyr.add_argument("--lyrics-file", help="path to a text / LRC lyrics file (an error when it cannot be read)")
    lyr.add_argument("--lyrics-text", help="the lyrics themselves, as text")
    ap.add_argument(
        "--notes",
        nargs="+",
        metavar="FILE",
        help="one or more JSON files from opentune_get_notes (content clock), or one file with a merged "
        "array; used for snapping and splitting (one audio file only)",
    )
    ap.add_argument(
        "--track-label",
        action="append",
        metavar="FILE=NAME",
        help="name of the singer or part on that audio file, matched against {name} marks in the lyrics; repeatable",
    )
    ap.add_argument(
        "--language",
        default="auto",
        help="auto, or a language the aligner supports: zh yue en de es fr it pt ru ko ja",
    )
    ap.add_argument("--out", help="write the JSON here (default: standard output)")
    ap.add_argument("--backend", choices=["qwen", "fake"], default="qwen")
    ap.add_argument("--fake-truth", help="JSON script for --backend fake (testing only)")
    ap.add_argument("--model-size", choices=["auto", "0.6B", "1.7B"], default="auto")
    ap.add_argument("--device", help="torch device, for example cpu or cuda:0 (default: automatic)")
    ap.add_argument("--snap-window", type=float, default=DEFAULT_SNAP_WINDOW, help="seconds either side of a token start")
    args = ap.parse_args(argv)

    if args.notes and len(args.audio) > 1:
        ap.error("--notes works with one audio file; run that track again on its own with --notes to snap it to its notes")
    labels = _track_labels(args.track_label, args.audio)
    lyrics = _read_lyrics(args.lyrics_file, args.lyrics_text)
    try:
        precheck(args.language, lyrics)  # before any model is loaded
    except UnsupportedLanguage as exc:
        raise SystemExit(f"error: {exc}") from exc
    notes = _read_notes(args.notes)
    inputs = []
    for path, label in zip(args.audio, labels):
        x, sr = load_audio(path)
        inputs.append(TrackInput(resample(x, sr, TARGET_SR), os.path.basename(path), sr, label, notes, bool(args.notes)))
    if args.backend == "fake":
        if not args.fake_truth:
            ap.error("--backend fake needs --fake-truth")
        asr, aligner = _fake_backends(args.fake_truth, len(inputs))
    else:
        asr, aligner = _qwen_backends(args.model_size, args.device)  # loaded once for every track
    info = {"asr": asr.name, "aligner": aligner.name}
    try:
        if len(inputs) == 1:
            one = inputs[0]
            doc = build_timeline(
                one.x,
                asr,
                aligner,
                lyrics=lyrics,
                notes=notes,
                language=args.language,
                snap_window=args.snap_window,
                audio_name=one.audio_name,
                sample_rate=one.sample_rate,
                model_info=info,
                notes_requested=bool(args.notes),
                label=one.label,
            )
        else:
            doc = build_multitrack(
                inputs, asr, aligner, lyrics=lyrics, language=args.language, snap_window=args.snap_window, model_info=info
            )
    except UnsupportedLanguage as exc:
        raise SystemExit(f"error: {exc}") from exc
    problems = validate_output(doc)
    if problems:
        print("warning: output failed its own structure check: " + "; ".join(problems[:5]), file=sys.stderr)
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text + "\n")
        if doc["mode"] == "multi_track":
            print(f"wrote {args.out}: {len(doc['tracks'])} tracks, {len(doc['lyric_lines'])} lyric lines", file=sys.stderr)
        else:
            print(f"wrote {args.out}: {len(doc['lines'])} lines, {len(doc['sections'])} sections", file=sys.stderr)
    else:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
