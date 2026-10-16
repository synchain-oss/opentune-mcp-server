# SPDX-License-Identifier: MIT
"""Parse user-supplied lyrics: section tags, LRC times, bracketed backing vocals and "x2" repeats."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Canonical label -> spellings accepted inside a tag (lower-case, compared after stripping spaces).
_LABELS: dict[str, tuple[str, ...]] = {
    "intro": ("intro", "introduction", "前奏", "序"),
    "verse": ("verse", "主歌", "歌段"),
    "pre-chorus": ("prechorus", "pre-chorus", "pre chorus", "预副歌", "导歌", "过渡"),
    "chorus": ("chorus", "hook", "refrain", "副歌", "高潮"),
    "bridge": ("bridge", "桥段", "桥", "过桥"),
    "interlude": ("interlude", "间奏", "solo"),
    "outro": ("outro", "ending", "尾声", "尾奏", "结尾"),
}
_LABEL_LOOKUP = {spelling.replace(" ", ""): canon for canon, names in _LABELS.items() for spelling in names}

_OPEN = "[【(（"
_CLOSE = "]】)）"
_REPEAT_TAIL = re.compile(
    r"\s*[\[(（【]?\s*(?:(?:[×*]|(?<=[\s\[(（【])[xX])\s*(\d{1,2})|重复\s*(\d{1,2})\s*次?)\s*[\])）】]?\s*$"
)
_LRC_TIME = re.compile(r"^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_LRC_META = re.compile(r"^\[(?:ti|ar|al|by|offset|length|re|ve|au|lr):.*\]$", re.IGNORECASE)
_TAG_ONLY = re.compile(r"^[\[【(（]\s*([^\]】)）]*?)\s*[\]】)）]$")
_NUM_SUFFIX = re.compile(r"^(.*?)[\s_-]*(\d{1,2}|[一二三四五六七八九])?$")
_ZH_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_MAX_REPEAT = 8


@dataclass
class LyricLine:
    text: str  # as written, without tags, times and the repeat marker
    raw: str
    label: str | None = None  # canonical section label from the user's tag
    label_number: int | None = None  # "Verse 2" -> 2
    block: int = 0  # index of the tag block (or blank-line paragraph) the line belongs to
    lrc_time: float | None = None
    backing: bool = False  # the whole line was in brackets
    backing_text: str = ""  # bracketed text inside an otherwise normal line
    expanded: bool = False  # produced by "x2" or by repeating a bare tag


@dataclass
class ParsedLyrics:
    lines: list[LyricLine] = field(default_factory=list)
    has_labels: bool = False
    has_blank_lines: bool = False
    warnings: list[str] = field(default_factory=list)  # assumptions made while parsing, shown to the user


def _parse_tag(inner: str) -> tuple[str, int | None, int] | None:
    """Return (canonical label, number, repeat) for a tag body such as "Chorus 2 x2", else None."""
    repeat = 1
    body = inner.strip()
    m = _REPEAT_TAIL.search(body)
    if m:
        repeat = int(m.group(1) or m.group(2))
        body = body[: m.start()].strip()
    num = None
    m2 = _NUM_SUFFIX.match(body)
    if m2 and m2.group(2):
        body = m2.group(1).strip()
        num = _ZH_NUM.get(m2.group(2)) or int(m2.group(2))
    key = body.lower().replace(" ", "")
    if key in _LABEL_LOOKUP:
        return _LABEL_LOOKUP[key], num, max(1, min(repeat, _MAX_REPEAT))
    return None


def _lrc_seconds(m: re.Match[str]) -> float:
    frac = m.group(3) or "0"
    return int(m.group(1)) * 60 + int(m.group(2)) + int(frac) / (10 ** len(frac))


def _split_inline_backing(text: str) -> tuple[str, str]:
    """Remove "(oh yeah)" style segments from a sung line; return (main text, backing text)."""
    backing: list[str] = []

    def take(m: re.Match[str]) -> str:
        backing.append(m.group(1).strip())
        return " "

    main = re.sub(r"[(（]([^()（）]*)[)）]", take, text)
    return re.sub(r"\s+", " ", main).strip(), " ".join(b for b in backing if b)


def parse_lyrics(source: str) -> ParsedLyrics:
    """Parse lyrics text. Tags, LRC times and repeat markers never reach the sung text."""
    parsed = ParsedLyrics()
    label: str | None = None
    label_number: int | None = None
    block_repeat = 1
    block = 0
    block_start = 0  # index in parsed.lines where the current block starts
    block_tag = ""  # the text inside the tag that opened the current block
    seen_blocks: dict[str, list[LyricLine]] = {}
    pending_blank = False

    def close_block() -> None:
        nonlocal block_repeat
        added = parsed.lines[block_start:]
        if label is not None and not added and label in seen_blocks:
            # A bare tag stands for the earlier block of that label, as often as "x2" says.
            for _ in range(block_repeat):
                for ln in seen_blocks[label]:
                    parsed.lines.append(_copy(ln, label_number, block))
            if label_number is not None:
                parsed.warnings.append(
                    f"lyrics: [{block_tag}] has no text; the text of the earlier {label} block was assumed"
                )
        elif label is not None and added:
            seen_blocks[label] = list(added)
        if block_repeat > 1 and added:
            for _ in range(block_repeat - 1):
                for ln in added:
                    parsed.lines.append(_copy(ln, label_number, block))
        block_repeat = 1

    for raw in source.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip().lstrip("﻿")
        if not line:
            if parsed.lines:
                pending_blank = True
            continue
        if _LRC_META.match(line):
            continue
        lrc_time = None
        m = _LRC_TIME.match(line)
        while m:
            lrc_time = _lrc_seconds(m) if lrc_time is None else lrc_time
            line = line[m.end() :].lstrip()
            m = _LRC_TIME.match(line)
        tag = _TAG_ONLY.match(line) if line and line[0] in _OPEN else None
        parsed_tag = _parse_tag(tag.group(1)) if tag else None
        if parsed_tag is None and line and line[0] in "[【" and not tag:
            # "[Chorus] text on the same line"
            close = min((line.find(c) for c in "]】" if c in line), default=-1)
            if close > 0:
                lead = _parse_tag(line[1:close])
                if lead is not None:
                    close_block()
                    block += 1
                    block_start = len(parsed.lines)
                    label, label_number, block_repeat = lead
                    block_tag = line[1:close].strip()
                    parsed.has_labels = True
                    line = line[close + 1 :].strip()
                    pending_blank = False
        elif parsed_tag is not None:
            close_block()
            block += 1
            block_start = len(parsed.lines)
            label, label_number, block_repeat = parsed_tag
            block_tag = tag.group(1).strip()  # type: ignore[union-attr]
            parsed.has_labels = True
            pending_blank = False
            continue
        if not line:
            continue
        if pending_blank:
            parsed.has_blank_lines = True
            if label is None:  # blank lines split unlabelled paragraphs
                close_block()
                block += 1
                block_start = len(parsed.lines)
            pending_blank = False
        repeat = 1
        m = _REPEAT_TAIL.search(line)
        if m and line[: m.start()].strip():
            repeat = max(1, min(int(m.group(1) or m.group(2)), _MAX_REPEAT))
            line = line[: m.start()].strip()
        whole = re.fullmatch(r"[(（]([^()（）]*)[)）]", line)
        if whole:
            entry = LyricLine(whole.group(1).strip(), raw, label, label_number, block, lrc_time, backing=True)
        else:
            main, back = _split_inline_backing(line)
            entry = LyricLine(main, raw, label, label_number, block, lrc_time, backing_text=back)
        if not entry.text:
            continue
        parsed.lines.append(entry)
        for _ in range(repeat - 1):
            parsed.lines.append(_copy(entry, label_number, block))
    close_block()
    return parsed


def _copy(line: LyricLine, label_number: int | None, block: int) -> LyricLine:
    return LyricLine(
        line.text,
        line.raw,
        line.label,
        label_number if label_number is not None else line.label_number,
        block,
        None,
        line.backing,
        line.backing_text,
        True,
    )
