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
import platform
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
MANIFEST = os.path.join(HERE, "model_manifest.json")
QWEN_ASR_PIN = "qwen-asr==0.0.6"
TORCH_PIN = "torch==2.14.1"
TORCH_INDEX_CPU = "https://download.pytorch.org/whl/cpu"
TORCH_INDEX_CUDA = "https://download.pytorch.org/whl/cu128"
TORCH_APPROX = {"cpu": 250_000_000, "cuda": 3_000_000_000, "default": 400_000_000}
PACKAGES_APPROX = 600_000_000  # transformers, librosa, scipy and friends
# SudachiPy 0.7.0 (about 1.5-3 MB per platform wheel) and SudachiDict-core 20261015 (a 77 MB wheel
# holding a 202 MB dictionary file), checked on PyPI. Used to compare Japanese lyrics by reading.
JAPANESE_APPROX = 80_000_000
JAPANESE_INSTALLED_APPROX = 210_000_000
MIRRORS = ("hf", "modelscope")
UA = {"User-Agent": "opentune-lyrics-timeline-setup"}


# nagisa 0.2.11 (imported at module level by qwen_asr) depends on DyNet38 2.2, a compiled C++ library
# that ships wheels only, for CPython 3.9-3.14 (checked on PyPI: both packages list the same set), and
# for the platforms below. Anything else would make pip try to compile DyNet, which fails in practice.
NAGISA_PYTHONS = ((3, 10), (3, 14))  # the skill needs 3.10+; the wheels stop at 3.14
NAGISA_WHEELS = {
    "win32": {"x86_64"},  # no Windows on ARM wheels
    "darwin": {"x86_64", "arm64"},
    "linux": {"x86_64", "arm64"},
}


def current_platform() -> tuple[tuple[int, int], str, str]:
    """(Python major.minor, sys.platform, machine); a separate function so that tests can stub it."""
    return (sys.version_info[0], sys.version_info[1]), sys.platform, platform.machine()


def platform_problems(py: tuple[int, int], plat: str, machine: str) -> list[str]:
    """Why the pinned package set (nagisa -> DyNet38) cannot be installed here; empty when it can."""
    problems: list[str] = []
    lo, hi = NAGISA_PYTHONS
    if not lo <= py <= hi:
        problems.append(
            f"Python {py[0]}.{py[1]} is not supported: nagisa and DyNet38 ship wheels only for "
            f"Python {lo[0]}.{lo[1]} to {hi[0]}.{hi[1]} (this skill needs 3.10 or newer)"
        )
    key = "linux" if plat.startswith("linux") else plat
    arch = {"amd64": "x86_64", "x64": "x86_64", "aarch64": "arm64"}.get(machine.lower(), machine.lower())
    allowed = NAGISA_WHEELS.get(key)
    if allowed is None:
        problems.append(f"platform {plat} is not supported: nagisa and DyNet38 have no wheels for it")
    elif arch not in allowed:
        problems.append(
            f"{plat} on {machine} is not supported: nagisa and DyNet38 ship wheels for it only on "
            + ", ".join(sorted(allowed))
        )
    return problems


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
    total = model_bytes + TORCH_APPROX[variant] + PACKAGES_APPROX + JAPANESE_APPROX
    return {
        "home": home,
        "venv": os.path.join(home, "venv"),
        "models_dir": lhome.models_dir(home),
        "asr_size": size,
        "models": [{"repo": r, "approx_bytes": lhome.APPROX_BYTES[r]} for r in repos],
        "model_bytes": model_bytes,
        "torch": {"variant": variant, "pin": TORCH_PIN, "approx_bytes": TORCH_APPROX[variant]},
        "packages_approx_bytes": PACKAGES_APPROX,
        "japanese_readings": {
            "packages": ["sudachipy", "sudachidict-core"],
            "approx_bytes": JAPANESE_APPROX,
            "installed_approx_bytes": JAPANESE_INSTALLED_APPROX,
        },
        "total_approx_bytes": total,
        "mirror": mirror,
        "problems": platform_problems(*current_platform()),
    }


def print_plan(plan: dict[str, Any]) -> None:
    print("Lyrics timeline setup plan (nothing has been changed):")
    if plan.get("problems"):
        print("  NOT SUPPORTED HERE (nothing would be downloaded; --yes refuses):")
        for p in plan["problems"]:
            print(f"    - {p}")
    print(f"  Folder         : {plan['home']}")
    print(f"  Python venv    : {plan['venv']}")
    print(f"  Models         : {plan['models_dir']}  (Qwen3-ASR {plan['asr_size']} + forced aligner)")
    for m in plan["models"]:
        print(f"    - {m['repo']}  about {human(m['approx_bytes'])}")
    print(f"  PyTorch        : {plan['torch']['variant']} build, about {human(plan['torch']['approx_bytes'])}")
    print(f"  Other packages : about {human(plan['packages_approx_bytes'])}")
    ja = plan["japanese_readings"]
    print(
        f"  Japanese       : SudachiPy + SudachiDict-core (readings for Japanese lyrics), about "
        f"{human(ja['approx_bytes'])} download, {human(ja['installed_approx_bytes'])} on disk"
    )
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


def load_manifest() -> dict[str, Any]:
    """The pinned revisions and the size and sha256 of every model file, committed in this repo."""
    with open(MANIFEST, encoding="utf-8") as fh:
        return json.load(fh)["repos"]


def list_files(repo: str, mirror: str) -> list[dict[str, Any]]:
    """Files of a model repo at the pinned revision: path, size and download URL as the host lists them.

    The host's own digests are not trusted here; ``download_repo`` checks every file against the
    sha256 in the in-repo manifest.
    """
    pin = load_manifest()[repo]
    out: list[dict[str, Any]] = []
    if mirror == "modelscope":
        rev = urllib.parse.quote(pin["modelscope_revision"])
        data = _get_json(f"https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision={rev}&Recursive=true")
        for f in _ci(_ci(data, "Data") or {}, "Files") or []:
            if str(_ci(f, "Type")).lower() not in ("blob", "file"):
                continue
            out.append(
                {
                    "path": _ci(f, "Path"),
                    "size": int(_ci(f, "Size") or 0),
                    "url": f"https://modelscope.cn/api/v1/models/{repo}/repo?Revision={rev}&FilePath="
                    + urllib.parse.quote(str(_ci(f, "Path"))),
                }
            )
        return out
    sha = pin["hf_revision"]
    data = _get_json(f"{hf_endpoint()}/api/models/{repo}/tree/{sha}?recursive=1")
    for f in data:
        if f.get("type") != "file":
            continue
        lfs = f.get("lfs") or {}
        out.append(
            {
                "path": f["path"],
                "size": int(lfs.get("size") or f.get("size") or 0),
                "url": f"{hf_endpoint()}/{repo}/resolve/{sha}/{urllib.parse.quote(f['path'])}",
            }
        )
    return out


def safe_dest(target: str, rel: object) -> str:
    """Where a remote file path lands inside ``target``; ValueError when it would leave the folder."""
    if not isinstance(rel, str) or not rel or "\\" in rel or "\0" in rel or rel.startswith("/"):
        raise ValueError(f"unsafe remote file path: {rel!r}")
    parts = rel.split("/")
    if any(p in ("", ".", "..") or ":" in p for p in parts):  # also drive letters and stream names
        raise ValueError(f"unsafe remote file path: {rel!r}")
    root = os.path.realpath(target)
    dest = os.path.realpath(os.path.join(root, *parts))
    try:
        inside = os.path.commonpath([root, dest]) == root and dest != root
    except ValueError:  # another drive
        inside = False
    if not inside:
        raise ValueError(f"unsafe remote file path: {rel!r}")
    return dest


def file_matches(path: str, entry: dict[str, Any]) -> bool:
    """True when the file exists with the expected size and sha256. An entry without a digest is refused."""
    sha256 = str(entry.get("sha256") or "").lower()
    if len(sha256) != 64:
        raise RuntimeError(f"no sha256 for {entry.get('path')}; refusing to accept an unverified file")
    if not os.path.isfile(path) or os.path.getsize(path) != entry["size"]:
        return False
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest() == sha256


def download_file(entry: dict[str, Any], dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    try:
        req = urllib.request.Request(entry["url"], headers=UA)
        with urllib.request.urlopen(req, timeout=120) as resp, open(part, "wb") as out:  # noqa: S310
            for block in iter(lambda: resp.read(1 << 20), b""):
                out.write(block)
        if not file_matches(part, entry):
            raise RuntimeError(f"checksum mismatch for {entry['path']}; the file was discarded")
        os.replace(part, dest)
    finally:
        if os.path.exists(part):
            os.remove(part)


def download_repo(repo: str, mirror: str, home: str) -> None:
    target = lhome.model_dir(repo, home)
    listed = list_files(repo, mirror)
    if not listed:
        raise RuntimeError(f"no files listed for {repo} on {mirror}")
    # Check every path first, so that a bad listing writes nothing at all.
    dests = {str(e["path"]): safe_dest(target, e["path"]) for e in listed}
    expected = {f["path"]: f for f in load_manifest()[repo]["files"]}
    missing = sorted(set(expected) - set(dests))
    if missing:
        raise RuntimeError(f"{mirror} does not list {', '.join(missing)} for {repo} at the pinned revision")
    for entry in listed:
        pinned = expected.get(str(entry["path"]))
        if pinned is None:
            continue  # not in the manifest, so not verifiable: never downloaded
        entry = {**entry, "size": pinned["size"], "sha256": pinned["sha256"]}
        dest = dests[str(entry["path"])]
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
    # No dependencies: qwen-asr declares soynlp (GPL-3.0), gradio and flask, which this skill never
    # imports (Korean is sent to the aligner under a name that selects its space splitter, so the
    # soynlp branch is never reached). What it does import is pinned in requirements.in.
    run([py, "-m", "pip", "install", "--no-deps", QWEN_ASR_PIN])


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
    if plan["problems"]:
        for p in plan["problems"]:
            print(f"error: {p}", file=sys.stderr)
        return 2
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
