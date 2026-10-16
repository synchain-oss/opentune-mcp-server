# SPDX-License-Identifier: MIT
"""Where the venv and the models live, and which model size to use. Standard library only."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

ASR_REPOS = {"0.6B": "Qwen/Qwen3-ASR-0.6B", "1.7B": "Qwen/Qwen3-ASR-1.7B"}
ALIGNER_REPO = "Qwen/Qwen3-ForcedAligner-0.6B"
# Approximate download sizes in bytes (weights only), used for the plan and the consent text.
APPROX_BYTES = {"Qwen/Qwen3-ASR-0.6B": 1_880_000_000, "Qwen/Qwen3-ASR-1.7B": 4_700_000_000, ALIGNER_REPO: 1_840_000_000}


class HomeError(RuntimeError):
    pass


def data_home() -> str:
    """CLAUDE_PLUGIN_DATA first, then OPENTUNE_LYRICS_HOME; an error when neither is set."""
    for name in ("CLAUDE_PLUGIN_DATA", "OPENTUNE_LYRICS_HOME"):
        value = os.environ.get(name, "").strip()
        if value:
            return os.path.abspath(value)
    raise HomeError(
        "Neither CLAUDE_PLUGIN_DATA nor OPENTUNE_LYRICS_HOME is set. Set OPENTUNE_LYRICS_HOME to a "
        "short folder with ASCII characters only (for example C:\\OpenTuneLyrics) and run again."
    )


def models_dir(home: str | None = None) -> str:
    return os.path.join(home or data_home(), "models")


def venv_python(home: str | None = None) -> str:
    base = os.path.join(home or data_home(), "venv")
    return os.path.join(base, "Scripts", "python.exe") if sys.platform == "win32" else os.path.join(base, "bin", "python")


def has_nvidia_gpu() -> bool:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return False
    try:
        r = subprocess.run([exe, "-L"], capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0 and "GPU" in r.stdout


def model_dir(repo: str, home: str | None = None) -> str:
    return os.path.join(models_dir(home), repo.split("/")[-1])


def selected_size(home: str | None = None) -> str | None:
    """The size chosen by setup, if any."""
    try:
        with open(os.path.join(models_dir(home), "selected.json"), encoding="utf-8") as fh:
            size = json.load(fh).get("asr")
    except (OSError, ValueError):
        return None
    return size if size in ASR_REPOS else None
