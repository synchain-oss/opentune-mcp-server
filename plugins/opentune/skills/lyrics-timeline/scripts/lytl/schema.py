# SPDX-License-Identifier: MIT
"""Structural check of the timeline JSON (no third-party schema library)."""

from __future__ import annotations

from typing import Any

TOP_KEYS = (
    "version",
    "generator",
    "audio",
    "label",
    "language",
    "language_source",
    "mode",
    "models",
    "params",
    "sections",
    "lines",
    "breaths",
    "adlibs",
    "unmatched",
    "diffs",
    "suspects",
    "warnings",
    "confidence",
)
MULTI_TOP_KEYS = ("version", "generator", "mode", "language", "language_source", "models", "params", "lyric_lines", "tracks", "warnings")
SECTION_KEYS = ("id", "label", "occurrence", "start", "end", "lines", "source", "conf")
LINE_KEYS = ("id", "text", "start", "end", "section", "line_in_section", "sung", "absent_reason", "backing", "singers", "tokens")
TOKEN_KEYS = ("i", "text", "start", "voiced_start", "end", "conf", "type", "snap", "notes")
TOKEN_TYPES = ("char", "word", "adlib", "repeat")
DIFF_TYPES = ("not_sung", "adlib", "repeat_unwritten", "heard_differently", "backing_unaligned", "singer_mismatch")
ABSENT_REASONS = (None, "not_in_track", "not_recognised")
LANGUAGE_SOURCES = ("lyrics", "asr", "user")


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_output(doc: dict[str, Any]) -> list[str]:
    """Return a list of problems; an empty list means the document has the documented shape."""
    if doc.get("mode") == "multi_track":
        return validate_multitrack(doc)
    errs: list[str] = []
    for k in TOP_KEYS:
        if k not in doc:
            errs.append(f"missing top-level key {k}")
    if errs:
        return errs
    if doc["mode"] not in ("lyrics", "asr_only"):
        errs.append("mode must be lyrics, asr_only or multi_track")
    if doc["language_source"] not in LANGUAGE_SOURCES:
        errs.append("language_source must be lyrics, asr or user")
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
        if ln.get("absent_reason") not in ABSENT_REASONS or (ln.get("sung") and ln.get("absent_reason") is not None):
            errs.append(f"bad absent_reason in {ln.get('id')}")
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
    for key in ("breaths", "adlibs", "unmatched"):
        for item in doc[key]:
            if not (_num(item.get("start")) and _num(item.get("end"))):
                errs.append(f"bad {key} entry")
    for item in doc["unmatched"]:
        if not isinstance(item.get("heard_text"), str):
            errs.append("unmatched entry lacks heard_text")
    return errs


def validate_multitrack(doc: dict[str, Any]) -> list[str]:
    """The multi-track shape: shared fields, lyric_lines with sung_by, and one single-track result per track."""
    errs: list[str] = [f"missing top-level key {k}" for k in MULTI_TOP_KEYS if k not in doc]
    if errs:
        return errs
    if doc["language_source"] not in LANGUAGE_SOURCES:
        errs.append("language_source must be lyrics, asr or user")
    sung_lines: dict[str, set[str]] = {}  # track -> ids of its sung lines
    for t in doc["tracks"]:
        if not isinstance(t.get("track"), str):
            errs.append("track without an id")
        sung_lines[t.get("track")] = {ln.get("id") for ln in t.get("lines", []) if ln.get("sung")}
        errs.extend(f"{t.get('track')}: {e}" for e in validate_output({k: v for k, v in t.items() if k != "track"}))
    for ll in doc["lyric_lines"]:
        for k in ("id", "text", "singers", "sung_by"):
            if k not in ll:
                errs.append(f"lyric line {ll.get('id')} lacks {k}")
        for sb in ll.get("sung_by", []):
            if sb.get("track") not in sung_lines:
                errs.append(f"lyric line {ll.get('id')} names unknown track {sb.get('track')}")
            elif sb.get("line") != ll.get("id") or sb.get("line") not in sung_lines[sb["track"]]:
                errs.append(f"lyric line {ll.get('id')}: sung_by line {sb.get('line')} is not that sung line of {sb.get('track')}")
            if not (_num(sb.get("start")) and _num(sb.get("end")) and sb["end"] >= sb["start"]):
                errs.append(f"bad sung_by times in {ll.get('id')}")
            if not (_num(sb.get("conf")) and 0 <= sb["conf"] <= 1):
                errs.append(f"bad sung_by conf in {ll.get('id')}")
    return errs
