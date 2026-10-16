# SPDX-License-Identifier: MIT
"""Structural check of the timeline JSON (no third-party schema library)."""

from __future__ import annotations

from typing import Any

TOP_KEYS = (
    "version",
    "generator",
    "audio",
    "language",
    "mode",
    "models",
    "params",
    "sections",
    "lines",
    "breaths",
    "adlibs",
    "diffs",
    "suspects",
    "warnings",
    "confidence",
)
SECTION_KEYS = ("id", "label", "occurrence", "start", "end", "lines", "source", "conf")
LINE_KEYS = ("id", "text", "start", "end", "section", "line_in_section", "sung", "backing", "tokens")
TOKEN_KEYS = ("i", "text", "start", "voiced_start", "end", "conf", "type", "snap", "notes")
TOKEN_TYPES = ("char", "word", "adlib", "repeat")
DIFF_TYPES = ("not_sung", "adlib", "repeat_unwritten", "heard_differently", "backing_unaligned")


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_output(doc: dict[str, Any]) -> list[str]:
    """Return a list of problems; an empty list means the document has the documented shape."""
    errs: list[str] = []
    for k in TOP_KEYS:
        if k not in doc:
            errs.append(f"missing top-level key {k}")
    if errs:
        return errs
    if doc["mode"] not in ("lyrics", "asr_only"):
        errs.append("mode must be lyrics or asr_only")
    line_ids = set()
    for ln in doc["lines"]:
        for k in LINE_KEYS:
            if k not in ln:
                errs.append(f"line {ln.get('id')} lacks {k}")
        line_ids.add(ln.get("id"))
        prev_start = -1.0
        for tok in ln.get("tokens", []):
            for k in TOKEN_KEYS:
                if k not in tok:
                    errs.append(f"token {tok.get('text')} in {ln.get('id')} lacks {k}")
            if tok.get("type") not in TOKEN_TYPES:
                errs.append(f"bad token type {tok.get('type')}")
            if not (_num(tok.get("start")) and _num(tok.get("end")) and tok["end"] >= tok["start"]):
                errs.append(f"bad token times in {ln.get('id')}: {tok.get('text')}")
                continue
            if tok["start"] < prev_start:
                errs.append(f"tokens out of order in {ln.get('id')}")
            prev_start = tok["start"]
            if not (_num(tok.get("voiced_start")) and tok["start"] <= tok["voiced_start"] <= tok["end"] + 1e-6):
                errs.append(f"voiced_start outside token in {ln.get('id')}")
            if not (_num(tok.get("conf")) and 0 <= tok["conf"] <= 1):
                errs.append("conf must be within 0..1")
            if (tok.get("type") in ("adlib", "repeat")) != (tok.get("i") is None):
                errs.append("only ad-lib and repeat tokens have i = null")
            for sub in tok.get("notes", []):
                if not (_num(sub.get("start")) and _num(sub.get("end")) and sub["end"] > sub["start"]):
                    errs.append("bad notes[] sub-segment")
        if ln.get("sung") and not ln.get("tokens"):
            errs.append(f"sung line {ln.get('id')} has no tokens")
    for sec in doc["sections"]:
        for k in SECTION_KEYS:
            if k not in sec:
                errs.append(f"section {sec.get('id')} lacks {k}")
        for lid in sec.get("lines", []):
            if lid not in line_ids:
                errs.append(f"section {sec.get('id')} names unknown line {lid}")
    for d in doc["diffs"]:
        if d.get("type") not in DIFF_TYPES:
            errs.append(f"bad diff type {d.get('type')}")
    for key in ("breaths", "adlibs"):
        for item in doc[key]:
            if not (_num(item.get("start")) and _num(item.get("end"))):
                errs.append(f"bad {key} entry")
    return errs
