# SPDX-License-Identifier: MIT
"""Text normalisation for lyrics and ASR output.

Chinese is compared as toneless pinyin per character, Japanese by reading per mora (japanese.py),
Korean per syllable, and words of Latin or Cyrillic languages as lower-case words without accents
or apostrophes. Traditional characters are folded to simplified (Chinese only) with a small
built-in table of common characters; anything outside the table is kept as is (a known
limitation, see SKILL.md).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from .langs import is_hangul, script_language

# Two characters per entry: traditional first, simplified second.
_T2S_PAIRS = (
    "愛爱 們们 來来 個个 這这 說说 對对 時时 為为 會会 開开 關关 體体 從从 點点 讓让 過过 還还 "
    "間间 話话 經经 麼么 電电 頭头 見见 現现 該该 當当 後后 無无 聽听 樣样 實实 裡里 裏里 應应 "
    "學学 長长 問问 題题 東东 車车 門门 馬马 鳥鸟 魚鱼 風风 雲云 飛飞 歲岁 氣气 國国 邊边 記记 "
    "請请 認认 讀读 誰谁 謝谢 聲声 變变 歡欢 難难 離离 遠远 運运 進进 選选 達达 適适 連连 閃闪 "
    "閉闭 團团 園园 圓圆 圖图 場场 塊块 壞坏 處处 複复 夢梦 將将 導导 尋寻 師师 帶带 幫帮 幾几 "
    "張张 強强 復复 憶忆 憂忧 懷怀 戀恋 歸归 淚泪 漲涨 淨净 溫温 滿满 漸渐 濃浓 燈灯 燒烧 營营 "
    "煩烦 獨独 獻献 環环 療疗 盡尽 眾众 睜睁 碼码 確确 禮礼 稱称 穩稳 窮穷 節节 約约 級级 "
    "紅红 紀纪 純纯 紙纸 細细 終终 組组 結结 絕绝 給给 絡络 統统 絲丝 綠绿 維维 綿绵 緊紧 線线 "
    "緣缘 編编 縱纵 總总 繞绕 繼继 續续 纏缠 羅罗 習习 聖圣 聯联 職职 肅肃 脈脉 腦脑 臉脸 舉举 "
    "艱艰 藝艺 號号 蟲虫 補补 裝装 規规 視视 覺觉 親亲 觀观 計计 訂订 訊讯 討讨 許许 論论 設设 "
    "訪访 訴诉 詞词 試试 誠诚 詳详 誤误 課课 調调 談谈 諒谅 諸诸 謊谎 謎谜 謠谣 證证 識识 譜谱 "
    "貓猫 貝贝 財财 貧贫 貴贵 費费 賣卖 質质 購购 賽赛 贈赠 趕赶 跡迹 蹤踪 轉转 輕轻 輩辈 輪轮 "
    "輸输 辦办 辭辞 農农 迴回 遊游 違违 遲迟 遺遗 邏逻 郵邮 鄉乡 鎖锁 鐘钟 鐵铁 鑰钥 閒闲 闊阔 "
    "陽阳 陰阴 陣阵 隨随 隱隐 雙双 雜杂 霧雾 靜静 頁页 頂顶 項项 順顺 須须 預预 顏颜 願愿 類类 "
    "顧顾 飄飘 餘余 館馆 饑饥 駐驻 驅驱 驚惊 髮发 鬥斗 鳴鸣 麗丽 黃黄 黨党 齊齐 齒齿 龍龙 灣湾 "
    "擁拥 擔担 據据 擇择 攝摄 敵敌 斷断 曉晓 曬晒 樂乐 橋桥 歷历 殘残 沖冲 湧涌 滅灭 漢汉 "
    "潔洁 澀涩 爾尔 獸兽 瑪玛 畫画 異异 癡痴 礙碍 禍祸 禪禅 籠笼 糾纠 絃弦 翹翘 臺台 與与 "
    "華华 萬万 蓋盖 蘭兰 衝冲 襲袭 觸触 豐丰 賜赐 賴赖 贏赢 軟软 載载 較较 輝辉 轟轰 鄰邻 "
    "針针 釘钉 銀银 鋒锋 錯错 鍵键 鎮镇 鏡镜 陳陈 陸陆 險险 隻只 雖虽 響响 顯显 驗验 髒脏 "
    "鬧闹 鮮鲜 鷹鹰 麥麦"
)
_T2S = {pair[0]: pair[1] for pair in _T2S_PAIRS.split()}

_DIGIT_ZH = "零一二三四五六七八九"
_EN_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen"
).split()
_EN_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()

# Characters that are commonly confused when a vocal is transcribed without a reference text.
HOMOPHONE_GROUPS = (
    "的得地",
    "在再",
    "她他它祂",
    "做作",
    "哪那",
    "像象",
    "以已",
    "带戴",
    "才材",
    "座坐",
    "吗嘛麻",
    "呀啊",
    "辉挥",
    "分份",
    "曾增",
    "必毕",
    "是事",
    "泪累",
)

FILLERS_ZH = set("啊哦噢哎呀嗯呜哟唉嘿哈啦喔嗷呐")
FILLERS_EN = {
    "oh", "ah", "yeah", "ooh", "uh", "hey", "la", "na", "mm", "hmm", "woah", "whoa", "ha", "yo",
    "eh", "ay", "ayy", "ohh", "aah", "mmm", "ooh", "oo",
}
FILLERS_KO = set("아오우예음라워어에야")  # a word made only of these syllables (아, 오오, 라라) is a filler


@dataclass(frozen=True)
class Unit:
    """One alignment unit: a CJK character or a Latin word."""

    text: str
    kind: str  # "char" or "word"

    @property
    def key(self) -> str:
        return unit_key(self)


def to_simplified(text: str) -> str:
    return "".join(_T2S.get(ch, ch) for ch in text)


def is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0x20000 <= cp <= 0x2A6DF
        or 0xF900 <= cp <= 0xFAFF
    )


def _num_en(n: int) -> str:
    if n < 20:
        return _EN_ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _EN_TENS[tens] + ("" if ones == 0 else " " + _EN_ONES[ones])
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        out = _EN_ONES[hundreds] + " hundred"
        return out if rest == 0 else out + " " + _num_en(rest)
    return " ".join(_EN_ONES[int(d)] for d in str(n))


def digits_to_words(text: str, language: str) -> str:
    """Spell out digit runs. Chinese reads digit by digit; English reads numbers below 1000 whole."""

    def repl(match: re.Match[str]) -> str:
        run = match.group(0)
        if language == "en":
            if len(run) <= 3 and (run[0] != "0" or run == "0"):
                return " " + _num_en(int(run)) + " "
            return " " + " ".join(_EN_ONES[int(d)] for d in run) + " "
        return "".join(_DIGIT_ZH[int(d)] for d in run)

    return re.sub(r"[0-9]+", repl, text)


def strip_punctuation(text: str) -> str:
    """Replace punctuation, symbols and spacing by single spaces; keep in-word apostrophes."""
    out: list[str] = []
    for i, ch in enumerate(text):
        if ch in "'’" and 0 < i < len(text) - 1 and text[i - 1].isalpha() and text[i + 1].isalpha():
            out.append("'")
        elif unicodedata.category(ch)[0] in "LN":
            out.append(ch)
        else:
            out.append(" ")
    return re.sub(r"\s+", " ", "".join(out)).strip()


def detect_language(text: str) -> str:
    """The language the writing points to (zh, ja, ko or ru); "en" for Latin script or anything else."""
    lang = script_language(text)
    return lang if lang in ("zh", "ja", "ko", "ru") else "en"


def tokenize(text: str, language: str = "auto") -> list[Unit]:
    """Normalise ``text`` and split it into alignment units.

    Chinese and Cantonese: one per character; Japanese: one per kanji or kana syllable (see
    japanese.py); everything else: one per word. A Chinese character inside a word-based language
    is its own unit, as the aligner splits it. Latin words are lower-cased.
    """
    lang = detect_language(text) if language == "auto" else language
    if lang == "ja":
        from .japanese import ja_units

        return ja_units(text)[1]
    if lang in ("zh", "yue", "en"):
        cleaned = strip_punctuation(digits_to_words(to_simplified(text), lang))
    else:  # digits stay as written: only Chinese and English have a reading rule for them
        cleaned = strip_punctuation(unicodedata.normalize("NFKC", text))
    units: list[Unit] = []
    word: list[str] = []

    def flush() -> None:
        if word:
            units.append(Unit("".join(word).lower(), "word"))
            word.clear()

    for ch in cleaned:
        if is_cjk(ch):
            flush()
            units.append(Unit(ch, "char"))
        elif ch.isspace():
            flush()
        else:
            word.append(ch)
    flush()
    return units


try:  # pypinyin is optional; without it Chinese is compared by character.
    from pypinyin import Style, lazy_pinyin  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised only without the optional package
    lazy_pinyin = None  # type: ignore[assignment]
    Style = None  # type: ignore[assignment]


def have_pinyin() -> bool:
    return lazy_pinyin is not None


def word_key(text: str) -> str:
    """Comparison key of a word: lower case, accents and apostrophes removed (café = cafe, don't = dont)."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn" and c not in "'’")


def unit_key(unit: Unit) -> str:
    """Comparison key: toneless pinyin for a Chinese character, the folded word otherwise."""
    if unit.kind == "char" and lazy_pinyin is not None:
        return lazy_pinyin(unit.text, style=Style.NORMAL, errors="default")[0]
    if unit.kind == "word":
        return word_key(unit.text)
    return unit.text


def match_sequence(text: str, language: str) -> tuple[list[Unit], list[tuple[str, tuple[int, ...]]]]:
    """Units of ``text`` and the key sequence used to compare it: (key, indexes of owning units).

    Most languages have one key per unit. Japanese has one per mora of the reading (a kanji can own
    several, and the kanji of one word can share them); Korean one per syllable of each word.
    """
    if language == "ja":
        from .japanese import ja_sequence

        return ja_sequence(text)
    units = tokenize(text, language)
    if language != "ko":
        return units, [(unit_key(u), (i,)) for i, u in enumerate(units)]
    seq: list[tuple[str, tuple[int, ...]]] = []
    for i, u in enumerate(units):
        rest = ""
        for ch in u.text:
            if is_hangul(ch):
                if rest:
                    seq.append((word_key(rest), (i,)))
                    rest = ""
                seq.append((ch, (i,)))
            else:
                rest += ch
        if rest:
            seq.append((word_key(rest), (i,)))
    return units, seq


def is_filler(unit: Unit) -> bool:
    """Sung sounds without words: 啊, oh, あ / ねえ (per syllable), 아 / 오오."""
    if unit.kind == "char":
        from .japanese import is_filler_kana

        return unit.text in FILLERS_ZH or is_filler_kana(unit.text)
    if unit.text and all(is_hangul(c) for c in unit.text):
        return all(c in FILLERS_KO for c in unit.text)
    return unit.text in FILLERS_EN


def homophone_alternatives(ch: str) -> list[str]:
    for group in HOMOPHONE_GROUPS:
        if ch in group:
            return [c for c in group if c != ch]
    return []


def units_text(units: list[Unit]) -> str:
    """Join units for display or for a backend: CJK characters directly, Latin words with spaces."""
    out: list[str] = []
    prev: Unit | None = None
    for unit in units:
        if prev is not None and (unit.kind == "word" or prev.kind == "word"):
            out.append(" ")
        out.append(unit.text)
        prev = unit
    return "".join(out)
