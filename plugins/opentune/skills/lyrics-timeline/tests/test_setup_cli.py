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
    with pytest.raises(RuntimeError, match="no sha256"):  # an entry without a digest is refused, not passed
        setup_script.file_matches(str(path), {"size": len(body)})
    with pytest.raises(RuntimeError, match="no sha256"):
        setup_script.file_matches(str(path), {"size": len(body), "sha256": None, "git_sha1": "ab" * 20})
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
    notes = tmp_path / "notes.json"  # two pages of opentune_get_notes; the second repeats a note of the first
    notes.write_text(json.dumps({"notes": [{"index": 0, "startContentSec": 1.03, "endContentSec": 1.3}], "nextCursor": "c1"}), encoding="utf-8")
    notes2 = tmp_path / "notes2.json"
    notes2.write_text(
        json.dumps({"notes": [{"index": 0, "startContentSec": 1.03, "endContentSec": 1.3}, {"index": 1, "startContentSec": 1.43, "endContentSec": 1.7}]}),
        encoding="utf-8",
    )
    out = tmp_path / "out.json"
    r = _run(
        CLI, str(wav), "--lyrics-file", str(lyr), "--notes", str(notes), str(notes2), "--language", "zh", "--out", str(out),
        "--backend", "fake", "--fake-truth", str(script), env=_env(),
    )
    assert r.returncode == 0, r.stderr
    doc = json.loads(out.read_text(encoding="utf-8"))
    sys.path.insert(0, SCRIPTS)
    from lytl.schema import validate_output  # noqa: PLC0415

    assert validate_output(doc) == []
    assert doc["audio"]["name"] == "vocal.wav" and len(doc["lines"]) == 8
    assert doc["lines"][0]["tokens"][0]["snap"]["source"] == "note"
    assert doc["params"]["notes_given"] == 2  # merged from both files, the repeated note counted once
    assert doc["lines"][0]["tokens"][1]["snap"]["source"] == "note"  # only the second file has this note


def test_cli_without_models_explains_how_to_get_them(tmp_path, vocal):
    wav = tmp_path / "v.wav"
    with wave.open(str(wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((vocal[:SR] * 32767).astype("<i2").tobytes())
    r = _run(CLI, str(wav), env=_env(OPENTUNE_LYRICS_HOME=str(tmp_path / "empty")))
    assert r.returncode != 0 and "setup.py" in r.stderr


def _setup_module():
    sys.path.insert(0, SCRIPTS)
    import setup as setup_script  # noqa: PLC0415

    return setup_script


def test_interrupted_download_removes_the_part_file(tmp_path, monkeypatch):
    setup_script = _setup_module()

    class Broken:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self, n=-1):
            if not getattr(self, "sent", False):
                self.sent = True
                return b"half"
            raise OSError("connection reset")

    monkeypatch.setattr(setup_script.urllib.request, "urlopen", lambda *a, **k: Broken())
    dest = tmp_path / "m" / "w.bin"
    entry = {"path": "w.bin", "size": 8, "sha256": "0" * 64, "url": "https://example.invalid/w"}
    with pytest.raises(OSError):
        setup_script.download_file(entry, str(dest))
    assert not dest.exists() and not (tmp_path / "m" / "w.bin.part").exists()


@pytest.mark.parametrize(
    "bad", ["../evil", "a/../../evil", "/abs/evil", "C:/evil", "C:evil", "a\\b", "..", "", "a//b", "./x", "x:stream"]
)
def test_safe_dest_refuses_paths_that_leave_the_folder(tmp_path, bad):
    setup_script = _setup_module()
    with pytest.raises(ValueError, match="unsafe"):
        setup_script.safe_dest(str(tmp_path / "model"), bad)
    assert setup_script.safe_dest(str(tmp_path / "model"), "sub/ok.json").endswith(os.path.join("sub", "ok.json"))


@pytest.mark.parametrize("bad", ["../evil", "C:/Windows/evil.dll", "/etc/evil", "ok/../../evil"])
def test_download_repo_refuses_a_listed_path_that_escapes_and_writes_nothing(tmp_path, monkeypatch, bad):
    setup_script = _setup_module()
    repo = setup_script.lhome.ALIGNER_REPO
    good = setup_script.load_manifest()[repo]["files"][0]
    listing = [
        {"path": good["path"], "size": good["size"], "url": "https://example.invalid/good"},
        {"path": bad, "size": 4, "url": "https://example.invalid/evil"},
    ]
    monkeypatch.setattr(setup_script, "list_files", lambda r, m: listing)
    calls: list[str] = []
    monkeypatch.setattr(setup_script, "download_file", lambda e, d: calls.append(d))
    with pytest.raises(ValueError, match="unsafe"):
        setup_script.download_repo(repo, "hf", str(tmp_path / "home"))
    assert calls == [] and not (tmp_path / "evil").exists() and not (tmp_path / "home").exists()


def test_download_repo_verifies_against_the_manifest_not_the_host(tmp_path, monkeypatch):
    setup_script = _setup_module()
    repo = setup_script.lhome.ALIGNER_REPO
    files = setup_script.load_manifest()[repo]["files"]
    listing = [{"path": f["path"], "size": 1, "sha256": "f" * 64, "url": "https://example.invalid/" + f["path"]} for f in files]
    listing.append({"path": "extra.bin", "size": 1, "url": "https://example.invalid/extra"})
    monkeypatch.setattr(setup_script, "list_files", lambda r, m: listing)
    seen: dict[str, dict] = {}
    monkeypatch.setattr(setup_script, "download_file", lambda e, d: seen.__setitem__(e["path"], e))
    setup_script.download_repo(repo, "hf", str(tmp_path / "home"))
    assert set(seen) == {f["path"] for f in files}  # the unlisted-in-manifest file is never fetched
    assert all(seen[f["path"]]["sha256"] == f["sha256"] and seen[f["path"]]["size"] == f["size"] for f in files)
    monkeypatch.setattr(setup_script, "list_files", lambda r, m: listing[:2])
    with pytest.raises(RuntimeError, match="does not list"):
        setup_script.download_repo(repo, "hf", str(tmp_path / "home2"))


def test_manifest_pins_every_repo_with_sha256_for_every_file():
    setup_script = _setup_module()
    manifest = setup_script.load_manifest()
    wanted = {*setup_script.lhome.ASR_REPOS.values(), setup_script.lhome.ALIGNER_REPO}
    assert set(manifest) == wanted
    for repo, entry in manifest.items():
        assert len(entry["hf_revision"]) == 40 and len(entry["modelscope_revision"]) == 40, repo
        assert entry["files"], repo
        for f in entry["files"]:
            assert len(f["sha256"]) == 64 and int(f["sha256"], 16) >= 0 and f["size"] > 0, (repo, f["path"])
            setup_script.safe_dest("/tmp/x", f["path"])
        assert any(f["path"].endswith(".safetensors") for f in entry["files"])


def test_listing_urls_use_the_pinned_revision(monkeypatch):
    setup_script = _setup_module()
    repo = setup_script.lhome.ALIGNER_REPO
    pin = setup_script.load_manifest()[repo]
    monkeypatch.setattr(setup_script, "_get_json", lambda url: [{"type": "file", "path": "config.json", "size": 5}])
    (entry,) = setup_script.list_files(repo, "hf")
    assert f"/resolve/{pin['hf_revision']}/" in entry["url"] and "/main/" not in entry["url"]
    monkeypatch.setattr(
        setup_script, "_get_json", lambda url: {"Data": {"Files": [{"Type": "blob", "Path": "config.json", "Size": 5}]}}
    )
    (entry,) = setup_script.list_files(repo, "modelscope")
    assert f"Revision={pin['modelscope_revision']}" in entry["url"]


def test_qwen_asr_is_installed_without_its_gpl_dependencies(monkeypatch, tmp_path):
    setup_script = _setup_module()
    cmds: list[list[str]] = []
    monkeypatch.setattr(setup_script, "run", lambda cmd: cmds.append(cmd))
    monkeypatch.setattr(setup_script.os.path, "isfile", lambda p: True)
    setup_script.install_runtime(str(tmp_path), "cpu")
    qwen = [c for c in cmds if setup_script.QWEN_ASR_PIN in c]
    assert qwen and "--no-deps" in qwen[0]
    reqs = open(setup_script.REQUIREMENTS, encoding="utf-8").read().lower()
    for banned in ("soynlp", "gradio", "flask", "qwen-asr"):
        assert banned not in "\n".join(l for l in reqs.splitlines() if not l.startswith("#"))


def test_cli_missing_lyrics_file_is_an_error_not_text(tmp_path, vocal):
    wav = tmp_path / "v.wav"
    with wave.open(str(wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((vocal[:SR] * 32767).astype("<i2").tobytes())
    r = _run(CLI, str(wav), "--lyrics-file", str(tmp_path / "nope.txt"), "--backend", "fake", "--fake-truth", "x", env=_env())
    assert r.returncode != 0 and "--lyrics-file" in r.stderr and "nope.txt" in r.stderr


def test_lyrics_text_and_file_are_exclusive_and_read_as_given(tmp_path):
    sys.path.insert(0, SCRIPTS)
    import lyrics_timeline as cli  # noqa: PLC0415

    f = tmp_path / "l.txt"
    f.write_text("\ufeffline one\n", encoding="utf-8")
    assert cli._read_lyrics(str(f), None) == "line one\n"
    assert cli._read_lyrics(None, "just text") == "just text"
    assert cli._read_lyrics(None, None) is None
    with pytest.raises(SystemExit):
        cli._read_lyrics(str(tmp_path / "missing.txt"), None)


def test_notes_pages_and_merged_array_give_the_same_notes(tmp_path):
    sys.path.insert(0, SCRIPTS)
    import lyrics_timeline as cli  # noqa: PLC0415

    n = [{"index": i, "startContentSec": i + 0.5, "endContentSec": i + 0.9} for i in range(5)]
    p1, p2, merged = tmp_path / "p1.json", tmp_path / "p2.json", tmp_path / "all.json"
    p1.write_text(json.dumps({"notes": n[:3], "nextCursor": "x"}), encoding="utf-8")
    p2.write_text(json.dumps({"notes": n[3:]}), encoding="utf-8")
    merged.write_text(json.dumps(n), encoding="utf-8")
    from_pages = cli._read_notes([str(p2), str(p1)])  # order of the files does not matter
    assert [x.start for x in from_pages] == [x.start for x in cli._read_notes([str(merged)])] == [0.5, 1.5, 2.5, 3.5, 4.5]
    assert cli._read_notes(None) == []
