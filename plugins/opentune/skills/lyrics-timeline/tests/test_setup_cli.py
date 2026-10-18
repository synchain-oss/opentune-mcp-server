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


def test_plan_reports_unsupported_python_and_platform_before_downloading(monkeypatch, capsys, tmp_path):
    sys.path.insert(0, SCRIPTS)
    import setup as setup_script  # noqa: PLC0415

    # nagisa -> DyNet38 ships wheels only for CPython 3.10..3.14 and for x86-64 Windows, macOS and Linux.
    assert setup_script.platform_problems((3, 12), "win32", "AMD64") == []
    assert setup_script.platform_problems((3, 14), "darwin", "arm64") == []
    assert setup_script.platform_problems((3, 12), "linux", "x86_64") == []
    assert "Python 3.15" in setup_script.platform_problems((3, 15), "win32", "AMD64")[0]
    assert "Python 3.9" in setup_script.platform_problems((3, 9), "darwin", "arm64")[0]
    assert "ARM64" in setup_script.platform_problems((3, 12), "win32", "ARM64")[0]
    assert "freebsd" in setup_script.platform_problems((3, 12), "freebsd14", "amd64")[0]

    monkeypatch.setenv("OPENTUNE_LYRICS_HOME", str(tmp_path / "h"))
    monkeypatch.setattr(setup_script, "current_platform", lambda: ((3, 15), "win32", "ARM64"))
    monkeypatch.setattr(sys, "argv", ["setup.py"])
    assert setup_script.main(["--plan", "--size", "0.6B", "--torch", "cpu"]) == 0
    out = capsys.readouterr().out
    assert "NOT SUPPORTED HERE" in out and "Python 3.15" in out and "ARM64" in out
    assert "Run again with --yes" not in out  # nothing to agree to
    # --yes refuses before anything is created or downloaded
    assert setup_script.main(["--yes", "--size", "0.6B", "--torch", "cpu"]) == 2
    assert not (tmp_path / "h").exists()


# --- PyTorch build: which index, from the driver's CUDA version ---------------------------------

NEW_HEADER = """+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 617.14                 KMD Version: 617.14        CUDA UMD Version: 13.4     |
+-----------------------------------------+------------------------+----------------------+
"""
OLD_HEADER = """+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 550.54.14              Driver Version: 550.54.14      CUDA Version: 12.4     |
|-----------------------------------------+------------------------+----------------------+
"""
GPU_ROW = """|   0  NVIDIA GeForce RTX 3070      WDDM  |   00000000:01:00.0  On |                  N/A |
| 30%   45C    P8             20W /  240W |     512MiB /   8192MiB |      2%      Default |
"""


def test_the_cuda_version_is_read_from_both_nvidia_smi_headers():
    setup_script = _setup_module()
    assert setup_script.parse_cuda_version(NEW_HEADER) == (13, 4)  # not the KMD version next to it
    assert setup_script.parse_cuda_version(OLD_HEADER) == (12, 4)
    assert setup_script.parse_cuda_version(OLD_HEADER.replace("12.4", "12.8")) == (12, 8)
    failed = "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver"
    for unreadable in ("", None, failed, "CUDA Version: N/A"):
        assert setup_script.parse_cuda_version(unreadable) is None


def test_one_run_of_nvidia_smi_tells_both_whether_there_is_a_gpu_and_its_cuda_version(monkeypatch):
    setup_script = _setup_module()
    from types import SimpleNamespace  # noqa: PLC0415

    parse = setup_script.parse_nvidia_smi
    assert parse(NEW_HEADER + GPU_ROW) == (True, (13, 4))
    assert parse(OLD_HEADER + GPU_ROW) == (True, (12, 4))
    assert parse(NEW_HEADER) == (True, (13, 4))  # a CUDA version is enough
    no_version = OLD_HEADER.replace("12.4", "N/A")
    assert parse(no_version + GPU_ROW) == (True, None)  # a GPU whose driver gives no version: CPU build, with advice
    assert parse(no_version) == (False, None)  # no version and no GPU listed
    assert parse("NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver") == (False, None)
    assert parse(None) == (False, None)

    calls: list[list[str]] = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return SimpleNamespace(returncode=0, stdout=NEW_HEADER + GPU_ROW)

    monkeypatch.setattr(setup_script.shutil, "which", lambda name: "nvidia-smi")
    monkeypatch.setattr(setup_script.subprocess, "run", run)
    assert setup_script.nvidia_driver() == (True, (13, 4)) and calls == [["nvidia-smi"]]
    monkeypatch.setattr(setup_script.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=9, stdout=NEW_HEADER))
    assert setup_script.nvidia_driver() == (False, None)
    monkeypatch.setattr(setup_script.shutil, "which", lambda name: None)
    assert setup_script.nvidia_driver() == (False, None)


def test_plan_runs_nvidia_smi_once(monkeypatch, capsys, tmp_path):
    setup_script = _setup_module()
    from types import SimpleNamespace  # noqa: PLC0415

    calls: list[list[str]] = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return SimpleNamespace(returncode=0, stdout=NEW_HEADER + GPU_ROW)

    monkeypatch.setattr(setup_script.shutil, "which", lambda name: "nvidia-smi")
    monkeypatch.setattr(setup_script.subprocess, "run", run)
    monkeypatch.setattr(setup_script, "current_platform", lambda: ((3, 12), "win32", "AMD64"))
    monkeypatch.setenv("OPENTUNE_LYRICS_HOME", str(tmp_path / "h"))
    assert setup_script.main(["--plan"]) == 0
    assert calls == [["nvidia-smi"]]
    assert "CUDA build (torch==2.14.1+cu130 from cu130 index)" in capsys.readouterr().out


@pytest.mark.parametrize(
    "cuda, index",
    [((13, 4), "cu130"), ((13, 0), "cu130"), ((12, 8), "cu126"), ((12, 6), "cu126"), ((12, 4), None), (None, None)],
)
def test_the_newest_cuda_build_the_driver_runs_is_chosen(cuda, index):
    assert _setup_module().cuda_index(cuda) == index


@pytest.mark.parametrize(
    "cuda, variant, index",
    [((13, 4), "cuda", "cu130"), ((12, 8), "cuda", "cu126"), ((12, 4), "cpu", "cpu"), (None, "cpu", "cpu")],
)
def test_with_an_nvidia_gpu_the_gpu_install_is_planned_when_the_driver_allows_it(cuda, variant, index):
    setup_script = _setup_module()
    t = setup_script.choose_torch("auto", True, cuda, "win32")
    assert (t["variant"], t["index"], t["problems"]) == (variant, index, [])
    advice = " ".join(t["advice"])
    if variant == "cuda":
        assert "GPU install is planned and recommended" in advice and "much faster" in advice
    else:  # a driver too old (or silent) for any CUDA build: the CPU build, and how to get the GPU
        assert "Update the NVIDIA driver to use the GPU" in advice and "--torch cuda" in advice
        assert ("supports only CUDA 12.4" if cuda else "did not report its CUDA version") in advice


def test_without_an_nvidia_gpu_or_on_macos_nothing_is_recommended():
    setup_script = _setup_module()
    assert setup_script.choose_torch("auto", False, None, "linux") == {
        "variant": "cpu", "index": "cpu", "driver_cuda": None, "advice": [], "problems": []
    }
    mac = setup_script.choose_torch("auto", False, None, "darwin")
    assert (mac["variant"], mac["index"], mac["advice"], mac["problems"]) == ("default", "pypi", [], [])
    cpu = setup_script.choose_torch("cpu", True, (13, 4), "win32")  # the CPU build asked for on purpose
    assert cpu["index"] == "cpu" and "GPU install" in cpu["advice"][0] and "recommended" in cpu["advice"][0]


@pytest.mark.parametrize(
    "nvidia, cuda, why",
    [(True, (12, 4), "supports CUDA 12.4"), (True, None, "could not be read"), (False, None, "no NVIDIA GPU")],
)
def test_torch_cuda_with_a_driver_that_cannot_run_it_is_refused_before_pip(nvidia, cuda, why):
    t = _setup_module().choose_torch("cuda", nvidia, cuda, "win32")
    assert len(t["problems"]) == 1 and why in t["problems"][0] and "CUDA 12.6 or newer" in t["problems"][0]
    assert "Update the NVIDIA driver, or use --torch cpu" in t["problems"][0]


def _stub_machine(monkeypatch, setup_script, nvidia: bool, cuda, plat=("win32", "AMD64")):
    monkeypatch.setattr(setup_script, "nvidia_driver", lambda: (nvidia, cuda))
    monkeypatch.setattr(setup_script, "current_platform", lambda: ((3, 12), *plat))


def test_plan_with_a_current_nvidia_driver_recommends_the_gpu_install(monkeypatch, capsys, tmp_path):
    setup_script = _setup_module()
    _stub_machine(monkeypatch, setup_script, True, (13, 4))
    monkeypatch.setenv("OPENTUNE_LYRICS_HOME", str(tmp_path / "h"))
    assert setup_script.main(["--plan"]) == 0
    out = capsys.readouterr().out
    assert "Qwen3-ASR 1.7B" in out and "CUDA build (torch==2.14.1+cu130 from cu130 index)" in out
    assert "Total download : about 10.2 GB" in out and "planned and recommended" in out
    assert out.rstrip().endswith("Run again with --yes to do it.")


def test_plan_and_yes_with_torch_cuda_and_an_old_driver_stop_before_anything_is_downloaded(monkeypatch, capsys, tmp_path):
    setup_script = _setup_module()
    _stub_machine(monkeypatch, setup_script, True, (12, 4))
    monkeypatch.setenv("OPENTUNE_LYRICS_HOME", str(tmp_path / "h"))
    assert setup_script.main(["--plan", "--torch", "cuda"]) == 0
    out = capsys.readouterr().out
    assert "NOT SUPPORTED HERE" in out and "the NVIDIA driver supports CUDA 12.4" in out
    assert "Run again with --yes" not in out
    monkeypatch.setattr(setup_script, "run", lambda cmd: pytest.fail(f"ran {cmd}"))
    assert setup_script.main(["--yes", "--torch", "cuda"]) == 2
    assert "the NVIDIA driver supports CUDA 12.4" in capsys.readouterr().err
    assert not (tmp_path / "h").exists()


def test_yes_with_an_old_driver_installs_the_cpu_build_and_says_why(monkeypatch, capsys, tmp_path):
    setup_script = _setup_module()
    _stub_machine(monkeypatch, setup_script, True, (12, 4))
    monkeypatch.setenv("OPENTUNE_LYRICS_HOME", str(tmp_path / "h"))
    cmds: list[list[str]] = []
    monkeypatch.setattr(setup_script, "run", lambda cmd: cmds.append(cmd))
    monkeypatch.setattr(setup_script, "download_repo", lambda repo, mirror, home: None)
    os.makedirs(tmp_path / "h" / "models")
    assert setup_script.main(["--yes"]) == 0
    assert "Update the NVIDIA driver to use the GPU" in capsys.readouterr().out
    torch_cmd = next(c for c in cmds if any(a.startswith("torch==") for a in c))
    assert "torch==2.14.1+cpu" in torch_cmd and torch_cmd[-1] == "https://download.pytorch.org/whl/cpu"
    assert json.loads((tmp_path / "h" / "models" / "selected.json").read_text(encoding="utf-8")) == {"asr": "0.6B"}


@pytest.mark.parametrize(
    "index, pin, url",
    [
        ("cu130", "torch==2.14.1+cu130", "https://download.pytorch.org/whl/cu130"),
        ("cu126", "torch==2.14.1+cu126", "https://download.pytorch.org/whl/cu126"),
        ("cpu", "torch==2.14.1+cpu", "https://download.pytorch.org/whl/cpu"),
        ("pypi", "torch==2.14.1", None),
    ],
)
def test_torch_is_installed_from_its_index_with_the_build_named(monkeypatch, tmp_path, index, pin, url):
    # Naming the build (+cu130) makes pip replace a CPU build installed earlier with the same version.
    setup_script = _setup_module()
    cmds: list[list[str]] = []
    monkeypatch.setattr(setup_script, "run", lambda cmd: cmds.append(cmd))
    monkeypatch.setattr(setup_script.os.path, "isfile", lambda p: True)
    setup_script.install_runtime(str(tmp_path), index)
    torch_cmd = next(c for c in cmds if any(a.startswith("torch==") for a in c))
    assert pin in torch_cmd
    assert (torch_cmd[torch_cmd.index("--index-url") + 1] if "--index-url" in torch_cmd else None) == url


def test_the_pinned_torch_has_wheels_on_every_index_setup_can_choose():
    # A static table, checked by hand on the date it gives against the index listings (see setup.py).
    setup_script = _setup_module()
    import datetime  # noqa: PLC0415

    datetime.date.fromisoformat(setup_script.TORCH_WHEELS_CHECKED)
    assert setup_script.TORCH_PIN == f"torch=={setup_script.TORCH_VERSION}"
    choosable = {name for _, name in setup_script.CUDA_INDEXES} | {"cpu"}
    assert choosable == {"cpu", "cu126", "cu130"}  # cu128 has no build of the pinned version
    for index in choosable:
        assert "win32-x86_64" in setup_script.TORCH_WHEELS[index], index
        assert setup_script.torch_wheel_problems(index, "win32", "AMD64") == []
    assert setup_script.TORCH_WHEELS["pypi"] == {"darwin-arm64"}  # macOS takes PyPI's build
    assert setup_script.torch_wheel_problems("pypi", "darwin", "arm64") == []
    # No macOS build for Intel: refused up front instead of a pip failure.
    assert "no wheel for darwin on x86_64 on PyPI" in setup_script.torch_wheel_problems("pypi", "darwin", "x86_64")[0]
    needs = [need for need, _ in setup_script.CUDA_INDEXES]  # newest CUDA first
    assert needs == sorted(needs, reverse=True)


def test_plan_on_an_intel_mac_is_not_supported(monkeypatch, capsys, tmp_path):
    setup_script = _setup_module()
    _stub_machine(monkeypatch, setup_script, False, None, ("darwin", "x86_64"))
    monkeypatch.setenv("OPENTUNE_LYRICS_HOME", str(tmp_path / "h"))
    assert setup_script.main(["--plan"]) == 0
    out = capsys.readouterr().out
    assert "NOT SUPPORTED HERE" in out and "PyTorch 2.14.1 has no wheel for darwin on x86_64" in out
    assert "Run again with --yes" not in out


def test_a_notes_page_without_notes_is_reported_when_several_pages_are_given(tmp_path):
    sys.path.insert(0, SCRIPTS)
    import lyrics_timeline as cli  # noqa: PLC0415

    full = tmp_path / "page1.json"
    full.write_text(json.dumps({"notes": [{"index": 0, "startContentSec": 1.0, "endContentSec": 1.3}]}), encoding="utf-8")
    empty = tmp_path / "page2.json"
    empty.write_text(json.dumps({"notes": [], "nextCursor": None}), encoding="utf-8")
    warnings: list[str] = []
    assert [n.start for n in cli._read_notes([str(full), str(empty)], warnings)] == [1.0]
    assert warnings == [
        "--notes file 'page2.json' holds no usable notes; only the notes of the other files were used "
        "(check that every page of opentune_get_notes was saved)"
    ]
    warnings.clear()  # one file without notes is reported by the pipeline instead
    assert cli._read_notes([str(empty)], warnings) == [] and warnings == []


def test_cli_warns_about_an_empty_notes_page(tmp_path, vocal, truth):
    wav = tmp_path / "vocal.wav"
    with wave.open(str(wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes((np.clip(vocal, -1, 1) * 32767).astype("<i2").tobytes())
    script = tmp_path / "truth.json"
    script.write_text(json.dumps([{"text": t.text, "start": t.start, "end": t.end} for t in truth], ensure_ascii=False), encoding="utf-8")
    page1 = tmp_path / "notes1.json"
    page1.write_text(json.dumps({"notes": [{"index": 0, "startContentSec": 1.03, "endContentSec": 1.3}], "nextCursor": "c1"}), encoding="utf-8")
    page2 = tmp_path / "notes2.json"
    page2.write_text(json.dumps({"notes": []}), encoding="utf-8")
    lyr = tmp_path / "lyrics.txt"
    lyr.write_text(LYRICS, encoding="utf-8")
    out = tmp_path / "out.json"
    r = _run(
        CLI, str(wav), "--lyrics-file", str(lyr), "--notes", str(page1), str(page2), "--out", str(out),
        "--backend", "fake", "--fake-truth", str(script), env=_env(),
    )
    assert r.returncode == 0, r.stderr
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["warnings"][0].startswith("--notes file 'notes2.json' holds no usable notes")
    assert doc["params"]["notes_given"] == 1
