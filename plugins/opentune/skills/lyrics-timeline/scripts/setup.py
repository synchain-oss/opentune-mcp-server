# SPDX-License-Identifier: MIT
"""Install the runtime and download the models for the lyrics timeline. Standard library only.

    python setup.py --plan        print what would be installed and downloaded; changes nothing
    python setup.py --yes         do it (create the venv, install packages, download the models)

The venv and the models go under CLAUDE_PLUGIN_DATA, or under OPENTUNE_LYRICS_HOME when that is
not set. Nothing outside that folder is touched: no PATH, no registry, no system packages.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lytl import home as lhome  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REQUIREMENTS = os.path.join(os.path.dirname(HERE), "requirements.in")
TORCH_PIN = "torch==2.14.1"
TORCH_INDEX_CPU = "https://download.pytorch.org/whl/cpu"
TORCH_INDEX_CUDA = "https://download.pytorch.org/whl/cu128"
TORCH_APPROX = {"cpu": 250_000_000, "cuda": 3_000_000_000, "default": 400_000_000}
PACKAGES_APPROX = 600_000_000  # transformers, librosa, scipy and friends
MIRRORS = ("hf", "modelscope")
UA = {"User-Agent": "opentune-lyrics-timeline-setup"}


def human(n: float) -> str:
    return f"{n / 1e9:.1f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


def choose_size(requested: str, nvidia: bool) -> str:
    if requested != "auto":
        return requested
    return "1.7B" if nvidia else "0.6B"


def torch_variant(cuda: bool | None, nvidia: bool) -> str:
    if sys.platform == "darwin":
        return "default"
    use_cuda = nvidia if cuda is None else cuda
    return "cuda" if use_cuda else "cpu"


def build_plan(size: str, mirror: str, variant: str, home: str) -> dict[str, Any]:
    repos = [lhome.ASR_REPOS[size], lhome.ALIGNER_REPO]
    model_bytes = sum(lhome.APPROX_BYTES[r] for r in repos)
    total = model_bytes + TORCH_APPROX[variant] + PACKAGES_APPROX
    return {
        "home": home,
        "venv": os.path.join(home, "venv"),
        "models_dir": lhome.models_dir(home),
        "asr_size": size,
        "models": [{"repo": r, "approx_bytes": lhome.APPROX_BYTES[r]} for r in repos],
        "model_bytes": model_bytes,
        "torch": {"variant": variant, "pin": TORCH_PIN, "approx_bytes": TORCH_APPROX[variant]},
        "packages_approx_bytes": PACKAGES_APPROX,
        "total_approx_bytes": total,
        "mirror": mirror,
    }


def print_plan(plan: dict[str, Any]) -> None:
    print("Lyrics timeline setup plan (nothing has been changed):")
    print(f"  Folder         : {plan['home']}")
    print(f"  Python venv    : {plan['venv']}")
    print(f"  Models         : {plan['models_dir']}  (Qwen3-ASR {plan['asr_size']} + forced aligner)")
    for m in plan["models"]:
        print(f"    - {m['repo']}  about {human(m['approx_bytes'])}")
    print(f"  PyTorch        : {plan['torch']['variant']} build, about {human(plan['torch']['approx_bytes'])}")
    print(f"  Other packages : about {human(plan['packages_approx_bytes'])}")
    print(f"  Mirror         : {plan['mirror']}")
    print(f"  Total download : about {human(plan['total_approx_bytes'])} (models alone {human(plan['model_bytes'])})")
    print("Run again with --yes to do it.")


# --- downloading -------------------------------------------------------------------------------


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - fixed https endpoints
        return json.load(resp)


def _ci(d: dict[str, Any], *names: str) -> Any:
    lowered = {k.lower(): v for k, v in d.items()}
    for n in names:
        if n.lower() in lowered:
            return lowered[n.lower()]
    return None


def hf_endpoint() -> str:
    return os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")


def list_files(repo: str, mirror: str) -> list[dict[str, Any]]:
    """Files of a model repo: path, size, expected digest (sha256 when the host gives one)."""
    out: list[dict[str, Any]] = []
    if mirror == "modelscope":
        data = _get_json(
            f"https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master&Recursive=true"
        )
        for f in _ci(_ci(data, "Data") or {}, "Files") or []:
            if str(_ci(f, "Type")).lower() not in ("blob", "file"):
                continue
            out.append(
                {
                    "path": _ci(f, "Path"),
                    "size": int(_ci(f, "Size") or 0),
                    "sha256": _ci(f, "Sha256"),
                    "url": f"https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath="
                    + urllib.parse.quote(str(_ci(f, "Path"))),
                }
            )
        return out
    data = _get_json(f"{hf_endpoint()}/api/models/{repo}/tree/main?recursive=1")
    for f in data:
        if f.get("type") != "file":
            continue
        lfs = f.get("lfs") or {}
        out.append(
            {
                "path": f["path"],
                "size": int(lfs.get("size") or f.get("size") or 0),
                "sha256": lfs.get("oid"),
                "git_sha1": None if lfs else f.get("oid"),
                "url": f"{hf_endpoint()}/{repo}/resolve/main/{urllib.parse.quote(f['path'])}",
            }
        )
    return out


def file_matches(path: str, entry: dict[str, Any]) -> bool:
    """True when the file exists with the expected size and digest."""
    if not os.path.isfile(path) or os.path.getsize(path) != entry["size"]:
        return False
    sha256 = entry.get("sha256")
    if sha256:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        return h.hexdigest() == str(sha256).lower()
    git_sha1 = entry.get("git_sha1")
    if git_sha1:
        with open(path, "rb") as fh:
            body = fh.read()
        return hashlib.sha1(b"blob %d\0" % len(body) + body).hexdigest() == git_sha1  # noqa: S324 - git object id
    return True


def download_file(entry: dict[str, Any], dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    req = urllib.request.Request(entry["url"], headers=UA)
    with urllib.request.urlopen(req, timeout=120) as resp, open(part, "wb") as out:  # noqa: S310
        for block in iter(lambda: resp.read(1 << 20), b""):
            out.write(block)
    if not file_matches(part, entry):
        os.remove(part)
        raise RuntimeError(f"checksum mismatch for {entry['path']}; the file was discarded")
    os.replace(part, dest)


def download_repo(repo: str, mirror: str, home: str) -> None:
    target = lhome.model_dir(repo, home)
    entries = list_files(repo, mirror)
    if not entries:
        raise RuntimeError(f"no files listed for {repo} on {mirror}")
    for entry in entries:
        dest = os.path.join(target, *str(entry["path"]).split("/"))
        if file_matches(dest, entry):
            print(f"  have {repo}/{entry['path']}")
            continue
        print(f"  get  {repo}/{entry['path']} ({human(entry['size'])})", flush=True)
        download_file(entry, dest)


# --- installing --------------------------------------------------------------------------------


def run(cmd: list[str]) -> None:
    print("  $ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def install_runtime(home: str, variant: str) -> None:
    venv = os.path.join(home, "venv")
    if not os.path.isfile(lhome.venv_python(home)):
        run([sys.executable, "-m", "venv", venv])
    py = lhome.venv_python(home)
    run([py, "-m", "pip", "install", "--upgrade", "pip"])
    index = {"cpu": TORCH_INDEX_CPU, "cuda": TORCH_INDEX_CUDA}.get(variant)
    cmd = [py, "-m", "pip", "install", TORCH_PIN]
    if index:
        cmd += ["--index-url", index]
    run(cmd)
    run([py, "-m", "pip", "install", "-r", REQUIREMENTS])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", action="store_true", help="print sizes and locations; change nothing")
    ap.add_argument("--yes", action="store_true", help="really install and download")
    ap.add_argument("--size", choices=["auto", "0.6B", "1.7B"], default="auto", help="ASR model size")
    ap.add_argument("--mirror", choices=MIRRORS, default="hf", help="model host (hf honours HF_ENDPOINT)")
    ap.add_argument("--torch", choices=["auto", "cpu", "cuda"], default="auto", help="PyTorch build")
    args = ap.parse_args(argv)
    if not args.plan and not args.yes:
        print("Refusing to do anything without --yes. Use --plan to see what would happen.", file=sys.stderr)
        return 2
    try:
        home = lhome.data_home()
    except lhome.HomeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    nvidia = lhome.has_nvidia_gpu()
    size = choose_size(args.size, nvidia)
    variant = torch_variant(None if args.torch == "auto" else args.torch == "cuda", nvidia)
    plan = build_plan(size, args.mirror, variant, home)
    if args.plan:
        print_plan(plan)
        return 0
    os.makedirs(home, exist_ok=True)
    install_runtime(home, variant)
    for repo in (lhome.ASR_REPOS[size], lhome.ALIGNER_REPO):
        print(f"Downloading {repo}")
        download_repo(repo, args.mirror, home)
    with open(os.path.join(lhome.models_dir(home), "selected.json"), "w", encoding="utf-8") as fh:
        json.dump({"asr": size}, fh)
    print("Setup finished. Run scripts/lyrics_timeline.py with the venv python:", lhome.venv_python(home))
    return 0


if __name__ == "__main__":
    sys.exit(main())
