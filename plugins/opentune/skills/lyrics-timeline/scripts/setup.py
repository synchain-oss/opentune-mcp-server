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
import re
import shutil
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
TORCH_VERSION = "2.14.1"
TORCH_PIN = f"torch=={TORCH_VERSION}"
TORCH_INDEX_URL = "https://download.pytorch.org/whl/{}"
# CUDA builds of the pinned PyTorch, newest first: (the CUDA version the NVIDIA driver must support
# at least, index name). A driver runs builds for its own CUDA version and older ones, so the
# newest build the driver supports is taken. There is no cu128 build of the pinned version.
CUDA_INDEXES = (((13, 0), "cu130"), ((12, 6), "cu126"))
# The platforms for which the pinned PyTorch has wheels for CPython 3.10 to 3.14 (every version the
# skill accepts, see NAGISA_PYTHONS), by package index; "pypi" is the default index, used on macOS.
# Checked by hand on TORCH_WHEELS_CHECKED against https://download.pytorch.org/whl/<index>/torch/
# and https://pypi.org/project/torch/ (macOS wheels exist only for Apple silicon). Check again and
# update this table whenever TORCH_VERSION changes; setup refuses a platform that is not listed
# for the index it would use, instead of letting pip fail.
TORCH_WHEELS_CHECKED = "2026-10-17"
TORCH_WHEELS = {
    "cpu": {"win32-x86_64", "linux-x86_64", "linux-arm64"},
    "cu126": {"win32-x86_64", "linux-x86_64", "linux-arm64"},
    "cu130": {"win32-x86_64", "linux-x86_64", "linux-arm64"},
    "pypi": {"darwin-arm64"},
}
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


def _arch(machine: str) -> str:
    return {"amd64": "x86_64", "x64": "x86_64", "aarch64": "arm64"}.get(machine.lower(), machine.lower())


def _os_key(plat: str) -> str:
    return "linux" if plat.startswith("linux") else plat


def platform_problems(py: tuple[int, int], plat: str, machine: str) -> list[str]:
    """Why the pinned package set (nagisa -> DyNet38) cannot be installed here; empty when it can."""
    problems: list[str] = []
    lo, hi = NAGISA_PYTHONS
    if not lo <= py <= hi:
        problems.append(
            f"Python {py[0]}.{py[1]} is not supported: nagisa and DyNet38 ship wheels only for "
            f"Python {lo[0]}.{lo[1]} to {hi[0]}.{hi[1]} (this skill needs 3.10 or newer)"
        )
    arch = _arch(machine)
    allowed = NAGISA_WHEELS.get(_os_key(plat))
    if allowed is None:
        problems.append(f"platform {plat} is not supported: nagisa and DyNet38 have no wheels for it")
    elif arch not in allowed:
        problems.append(
            f"{plat} on {machine} is not supported: nagisa and DyNet38 ship wheels for it only on "
            + ", ".join(sorted(allowed))
        )
    return problems


def torch_wheel_problems(index: str, plat: str, machine: str) -> list[str]:
    """Why the pinned PyTorch has no wheel for this platform on ``index`` (see TORCH_WHEELS)."""
    if f"{_os_key(plat)}-{_arch(machine)}" in TORCH_WHEELS.get(index, set()):
        return []
    where = "PyPI" if index == "pypi" else f"the {index} index"
    return [f"PyTorch {TORCH_VERSION} has no wheel for {plat} on {machine} on {where}"]


def human(n: float) -> str:
    return f"{n / 1e9:.1f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


def choose_size(requested: str, gpu: bool) -> str:
    """The ASR model size: 1.7B when PyTorch will run on an NVIDIA GPU, else 0.6B (or as requested)."""
    if requested != "auto":
        return requested
    return "1.7B" if gpu else "0.6B"


# --- PyTorch build -------------------------------------------------------------------------------

# nvidia-smi prints the CUDA version the driver supports in its header: "CUDA Version: 12.4" in
# older drivers, "CUDA UMD Version: 13.4" in newer ones (next to "KMD Version", which is not it).
_CUDA_VERSION = re.compile(r"\bCUDA\s+(?:UMD\s+)?Version\s*:\s*(\d+)\.(\d+)")


def parse_cuda_version(text: str | None) -> tuple[int, int] | None:
    """The CUDA version from the header that nvidia-smi prints; None when there is none."""
    m = _CUDA_VERSION.search(text or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def driver_cuda_version() -> tuple[int, int] | None:
    """The CUDA version the installed NVIDIA driver supports, read from ``nvidia-smi``."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        r = subprocess.run(
            [exe], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_cuda_version(r.stdout) if r.returncode == 0 else None


def cuda_index(cuda: tuple[int, int] | None) -> str | None:
    """The newest CUDA build of the pinned PyTorch that a driver for ``cuda`` runs; None if none."""
    if cuda is None:
        return None
    return next((name for need, name in CUDA_INDEXES if cuda >= need), None)


def _version(v: tuple[int, int]) -> str:
    return f"{v[0]}.{v[1]}"


def choose_torch(requested: str, nvidia: bool, cuda: tuple[int, int] | None, plat: str) -> dict[str, Any]:
    """Which PyTorch build to install and from which index, with advice and blocking problems.

    ``requested`` is the --torch value (auto, cpu or cuda), ``nvidia`` whether an NVIDIA GPU was
    found and ``cuda`` the CUDA version its driver supports (None when it could not be read).
    """
    oldest = _version(CUDA_INDEXES[-1][0])
    out: dict[str, Any] = {"variant": "cpu", "index": "cpu", "driver_cuda": _version(cuda) if cuda else None}
    advice: list[str] = []
    problems: list[str] = []
    if plat == "darwin":
        out.update(variant="default", index="pypi")  # PyPI's macOS build; there is no CUDA on macOS
    elif requested == "cuda":
        index = cuda_index(cuda)
        out.update(variant="cuda", index=index or CUDA_INDEXES[-1][1])
        if index is None:
            if not nvidia:
                why = "no NVIDIA GPU was found (nvidia-smi is missing or failed)"
            elif cuda is None:
                why = "the CUDA version of the NVIDIA driver could not be read from nvidia-smi"
            else:
                why = f"the NVIDIA driver supports CUDA {_version(cuda)}"
            problems.append(
                f"--torch cuda: {why}, but the CUDA builds of PyTorch {TORCH_VERSION} need a driver for "
                f"CUDA {oldest} or newer. Update the NVIDIA driver, or use --torch cpu"
            )
    elif nvidia:
        index = cuda_index(cuda)
        if index is None:
            have = f"supports only CUDA {_version(cuda)}" if cuda else "did not report its CUDA version"
            advice.append(
                f"An NVIDIA GPU was found, but its driver {have}; the CUDA builds of PyTorch {TORCH_VERSION} "
                f"need CUDA {oldest} or newer, so the CPU build is planned. Update the NVIDIA driver to use "
                "the GPU, then run setup again with --torch cuda."
            )
        elif requested == "auto":
            out.update(variant="cuda", index=index)
            advice.append(
                f"An NVIDIA GPU was found (driver supports CUDA {_version(cuda)}), so the GPU install is "
                "planned and recommended: Qwen3-ASR 1.7B with the CUDA build of PyTorch. The GPU is much "
                "faster; on a CPU the 0.6B model took about 6 to 8 minutes for an 8-track song."
            )
        else:
            advice.append(
                "An NVIDIA GPU was found: the GPU install (--torch auto or --torch cuda, with Qwen3-ASR "
                "1.7B) is recommended because the GPU is much faster."
            )
    out["advice"] = advice
    out["problems"] = problems
    return out


def build_plan(size: str, mirror: str, torch: dict[str, Any], home: str) -> dict[str, Any]:
    repos = [lhome.ASR_REPOS[size], lhome.ALIGNER_REPO]
    model_bytes = sum(lhome.APPROX_BYTES[r] for r in repos)
    variant = torch["variant"]
    total = model_bytes + TORCH_APPROX[variant] + PACKAGES_APPROX + JAPANESE_APPROX
    py, plat, machine = current_platform()
    problems = platform_problems(py, plat, machine)
    if not problems:  # a platform that nothing supports needs no second reason
        problems += torch_wheel_problems(torch["index"], plat, machine)
    problems += torch["problems"]
    return {
        "home": home,
        "venv": os.path.join(home, "venv"),
        "models_dir": lhome.models_dir(home),
        "asr_size": size,
        "models": [{"repo": r, "approx_bytes": lhome.APPROX_BYTES[r]} for r in repos],
        "model_bytes": model_bytes,
        "torch": {
            "variant": variant,
            "index": torch["index"],
            "pin": torch_pin(torch["index"]),
            "driver_cuda": torch["driver_cuda"],
            "approx_bytes": TORCH_APPROX[variant],
        },
        "packages_approx_bytes": PACKAGES_APPROX,
        "japanese_readings": {
            "packages": ["sudachipy", "sudachidict-core"],
            "approx_bytes": JAPANESE_APPROX,
            "installed_approx_bytes": JAPANESE_INSTALLED_APPROX,
        },
        "total_approx_bytes": total,
        "mirror": mirror,
        "advice": torch["advice"],
        "problems": problems,
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
    t = plan["torch"]
    build = {"cuda": "CUDA", "cpu": "CPU", "default": "standard"}[t["variant"]]
    where = "PyPI" if t["index"] == "pypi" else f"{t['index']} index"
    print(f"  PyTorch        : {build} build ({t['pin']} from {where}), about {human(t['approx_bytes'])}")
    print(f"  Other packages : about {human(plan['packages_approx_bytes'])}")
    ja = plan["japanese_readings"]
    print(
        f"  Japanese       : SudachiPy + SudachiDict-core (readings for Japanese lyrics), about "
        f"{human(ja['approx_bytes'])} download, {human(ja['installed_approx_bytes'])} on disk"
    )
    print(f"  Mirror         : {plan['mirror']}")
    print(f"  Total download : about {human(plan['total_approx_bytes'])} (models alone {human(plan['model_bytes'])})")
    for a in plan.get("advice", []):
        print(f"  Note           : {a}")
    if plan.get("problems"):
        print("Nothing can be installed with these settings (see NOT SUPPORTED HERE above).")
    else:
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


def torch_pin(index: str) -> str:
    """The pip requirement for PyTorch from ``index``.

    The builds on download.pytorch.org carry the index name as a local version (2.14.1+cu130).
    Naming it makes pip replace a build from another index (a CPU build installed earlier) instead
    of keeping it because the version number matches.
    """
    return TORCH_PIN if index == "pypi" else f"{TORCH_PIN}+{index}"


def install_runtime(home: str, index: str) -> None:
    venv = os.path.join(home, "venv")
    if not os.path.isfile(lhome.venv_python(home)):
        run([sys.executable, "-m", "venv", venv])
    py = lhome.venv_python(home)
    run([py, "-m", "pip", "install", "--upgrade", "pip"])
    cmd = [py, "-m", "pip", "install", torch_pin(index)]
    if index != "pypi":
        cmd += ["--index-url", TORCH_INDEX_URL.format(index)]
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
    torch = choose_torch(args.torch, nvidia, driver_cuda_version() if nvidia else None, current_platform()[1])
    size = choose_size(args.size, torch["variant"] == "cuda")
    plan = build_plan(size, args.mirror, torch, home)
    if args.plan:
        print_plan(plan)
        return 0
    if plan["problems"]:
        for p in plan["problems"]:
            print(f"error: {p}", file=sys.stderr)
        return 2
    for a in plan["advice"]:
        print(f"Note: {a}")
    os.makedirs(home, exist_ok=True)
    install_runtime(home, plan["torch"]["index"])
    for repo in (lhome.ASR_REPOS[size], lhome.ALIGNER_REPO):
        print(f"Downloading {repo}")
        download_repo(repo, args.mirror, home)
    with open(os.path.join(lhome.models_dir(home), "selected.json"), "w", encoding="utf-8") as fh:
        json.dump({"asr": size}, fh)
    print("Setup finished. Run scripts/lyrics_timeline.py with the venv python:", lhome.venv_python(home))
    return 0


if __name__ == "__main__":
    sys.exit(main())
