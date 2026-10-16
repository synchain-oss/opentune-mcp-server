# SPDX-License-Identifier: MIT
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import wave

import numpy as np
import pytest

from conftest import LYRICS, SR
from lytl import home as lhome

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
SETUP = os.path.join(SCRIPTS, "setup.py")
CLI = os.path.join(SCRIPTS, "lyrics_timeline.py")


def _env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PLUGIN_DATA", "OPENTUNE_LYRICS_HOME")}
    env.update(extra)
    return env


def _run(script: str, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-I", script, *args], capture_output=True, text=True, encoding="utf-8", env=env, check=False
    )


def test_plan_prints_sizes_and_writes_nothing(tmp_path):
    home = tmp_path / "lyrics-home"  # does not exist; --plan must not create it
    before = sorted(os.listdir(tmp_path))
    r = _run(SETUP, "--plan", "--size", "0.6B", "--torch", "cpu", env=_env(OPENTUNE_LYRICS_HOME=str(home)))
    assert r.returncode == 0, r.stderr
    assert "Qwen/Qwen3-ASR-0.6B" in r.stdout and "Qwen3-ForcedAligner-0.6B" in r.stdout
    assert "models alone 3.7 GB" in r.stdout
    assert not home.exists() and sorted(os.listdir(tmp_path)) == before


def test_plan_for_the_large_model_reports_6_5_gb(tmp_path):
    r = _run(SETUP, "--plan", "--size", "1.7B", "--torch", "cuda", env=_env(OPENTUNE_LYRICS_HOME=str(tmp_path / "h")))
    assert "models alone 6.5 GB" in r.stdout


def test_nothing_happens_without_yes(tmp_path):
    home = tmp_path / "h"
    r = _run(SETUP, env=_env(OPENTUNE_LYRICS_HOME=str(home)))
    assert r.returncode == 2 and not home.exists()


def test_missing_home_is_an_error(tmp_path):
    r = _run(SETUP, "--plan", env=_env())
    assert r.returncode == 2 and "OPENTUNE_LYRICS_HOME" in r.stderr


def test_plugin_data_wins_over_lyrics_home(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", str(tmp_path / "a"))
    monkeypatch.setenv("OPENTUNE_LYRICS_HOME", str(tmp_path / "b"))
    assert lhome.data_home() == str(tmp_path / "a")
    monkeypatch.delenv("CLAUDE_PLUGIN_DATA")
    assert lhome.data_home() == str(tmp_path / "b")
    monkeypatch.delenv("OPENTUNE_LYRICS_HOME")
    with pytest.raises(lhome.HomeError):
        lhome.data_home()


def test_model_choice_and_checksum(tmp_path):
    sys.path.insert(0, SCRIPTS)
    import setup as setup_script  # noqa: PLC0415

    assert setup_script.choose_size("auto", True) == "1.7B"
    assert setup_script.choose_size("auto", False) == "0.6B"
    assert setup_script.choose_size("0.6B", True) == "0.6B"
    body = b"model bytes"
    path = tmp_path / "w.bin"
    path.write_bytes(body)
    good = {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
    assert setup_script.file_matches(str(path), good)
    assert not setup_script.file_matches(str(path), {**good, "sha256": "0" * 64})
    assert not setup_script.file_matches(str(path), {**good, "size": 3})
    git_id = hashlib.sha1(b"blob %d\0" % len(body) + body).hexdigest()  # noqa: S324
    assert setup_script.file_matches(str(path), {"size": len(body), "git_sha1": git_id})
    assert not setup_script.file_matches(str(tmp_path / "missing"), good)


def test_download_discards_a_file_with_the_wrong_checksum(tmp_path, monkeypatch):
    sys.path.insert(0, SCRIPTS)
    import io
    import setup as setup_script  # noqa: PLC0415

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(setup_script.urllib.request, "urlopen", lambda *a, **k: Resp(b"tampered"))
    dest = tmp_path / "m" / "w.bin"
    entry = {"path": "w.bin", "size": 8, "sha256": hashlib.sha256(b"original").hexdigest(), "url": "https://example.invalid/w"}
    with pytest.raises(RuntimeError, match="checksum"):
        setup_script.download_file(entry, str(dest))
    assert not dest.exists() and not (tmp_path / "m" / "w.bin.part").exists()


def test_cli_end_to_end_with_the_fake_backend(tmp_path, vocal, truth):
    wav = tmp_path / "vocal.wav"
    with wave.open(str(wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((np.clip(vocal, -1, 1) * 32767).astype("<i2").tobytes())
    script = tmp_path / "truth.json"
    script.write_text(json.dumps([{"text": t.text, "start": t.start, "end": t.end} for t in truth], ensure_ascii=False), encoding="utf-8")
    lyr = tmp_path / "lyrics.txt"
    lyr.write_text(LYRICS, encoding="utf-8")
    notes = tmp_path / "notes.json"
    notes.write_text(json.dumps({"notes": [{"index": 0, "startContentSec": 1.03, "endContentSec": 1.3}]}), encoding="utf-8")
    out = tmp_path / "out.json"
    r = _run(
        CLI, str(wav), "--lyrics", str(lyr), "--notes", str(notes), "--language", "zh", "--out", str(out),
        "--backend", "fake", "--fake-truth", str(script), env=_env(),
    )
    assert r.returncode == 0, r.stderr
    doc = json.loads(out.read_text(encoding="utf-8"))
    sys.path.insert(0, SCRIPTS)
    from lytl.schema import validate_output  # noqa: PLC0415

    assert validate_output(doc) == []
    assert doc["audio"]["name"] == "vocal.wav" and len(doc["lines"]) == 8
    assert doc["lines"][0]["tokens"][0]["snap"]["source"] == "note"


def test_cli_without_models_explains_how_to_get_them(tmp_path, vocal):
    wav = tmp_path / "v.wav"
    with wave.open(str(wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((vocal[:SR] * 32767).astype("<i2").tobytes())
    r = _run(CLI, str(wav), env=_env(OPENTUNE_LYRICS_HOME=str(tmp_path / "empty")))
    assert r.returncode != 0 and "setup.py" in r.stderr
