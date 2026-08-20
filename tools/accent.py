"""Accent derivation from OpenJTalk full-context labels.

Validated 2026-08-20 against 箸/橋/端/花/鼻: the notation this emits for
箸/橋/端 is character-for-character Google's documented ^は!し / ^はし! / ^はし.

BASIS, stated once: OpenJTalk emits one HTS full-context label per phoneme.
  /F:f1_f2#f3_f4@f5_f6|f7_f8   f1 = morae in this accent phrase
                               f2 = accent position, 1-based, within the phrase
                               f5 = index of this accent phrase in its breath group
  /I:i1-i2@i3+i4&...           i3 = index of this breath group in the utterance
An accent phrase is therefore keyed by (i3, f5).  Silence/pause labels carry xx
and are skipped.  DO NOT use "the /A: a2 field resets to 1" as the boundary
test: it fails on `に引き換え`, whose two phrases both start at a2=1.
"""
import re
import pyopenjtalk        # or pyopenjtalk_plus, which exposes the same module name

F_RE = re.compile(r'/F:(\d+)_(\d+)#[^@]*@(\d+)_(\d+)')
I_RE = re.compile(r'/I:[^@]*@(\d+)\+')

TYPES = ("平板", "頭高", "中高", "尾高")
SMALL = "ゃゅょぁぃぅぇぉャュョァィゥェォ"


def phrases(text):
    """[(morae, accent_pos)] per accent phrase, in utterance order."""
    seen, out = set(), []
    for lab in pyopenjtalk.extract_fullcontext(text):
        f, i = F_RE.search(lab), I_RE.search(lab)
        if not f or not i:
            continue
        key = (int(i.group(1)), int(f.group(3)))
        if key in seen:
            continue
        seen.add(key)
        out.append((int(f.group(1)), int(f.group(2))))
    return out


def classify(bare_moras, probed_moras, probed_accent):
    """Accent type of the BARE word, decided on the PROBED string (word + が).

    probed_accent >= probed_moras -> the nucleus is on the probe particle, i.e.
                                     no drop inside the word: 平板 (0).
    probed_accent == bare_moras   -> drop on the word's last mora: 尾高.
    probed_accent == 1            -> 頭高.
    1 < probed_accent < bare_moras-> 中高.
    """
    if probed_accent == 0 or probed_accent >= probed_moras:
        return "平板", 0
    if probed_accent > bare_moras:
        return "不明", probed_accent           # refuse
    if probed_accent == 1:
        return "頭高", 1
    if probed_accent == bare_moras:
        return "尾高", bare_moras
    return "中高", probed_accent


def derive(word, probe="が"):
    """`ok` False means: refuse and queue for manual review.

    `guarded` True means the probe did not add exactly one mora, i.e. it changed
    the morphological reading (光 + が came back as 3 morae, not 4).  MEASURED at
    5 of 3,741 on this corpus.  Never emit notation for a guarded word.
    """
    bare, probed = phrases(word), phrases(word + probe)
    r = {"word": word, "bare": bare, "probed": probed,
         "bare_phrases": len(bare), "probed_phrases": len(probed)}
    if len(bare) != 1 or len(probed) != 1:
        r["ok"] = False
        r["reason"] = "multi-phrase: apply the rule to the LAST phrase only"
        return r
    bm, ba = bare[0]
    pm, pa = probed[0]
    if pm != bm + 1:
        r.update(ok=False, guarded=True, bare_moras=bm, probed_moras=pm,
                 reason="probe changed the reading; manual review")
        return r
    name, atype = classify(bm, pm, pa)
    r.update(ok=(name != "不明"), guarded=False, bare_moras=bm, bare_accent=ba,
             probed_moras=pm, probed_accent=pa, type=name, accent_type=atype)
    return r


def split_moras(kana):
    """Small kana attach to the preceding mora: きょ is one mora, not two."""
    out = []
    for ch in kana:
        if ch in SMALL and out:
            out[-1] += ch
        else:
            out.append(ch)
    return out


def yomigana(reading, accent_type):
    """Google's notation for ONE accent phrase.  `^` opens it; `!` follows the
    mora carrying the downstep; 平板 (0) emits no `!`.
    UNVERIFIED against a live API call -- see the harness."""
    moras = split_moras(reading)
    if accent_type <= 0 or accent_type > len(moras):
        return "^" + "".join(moras)
    return "^" + "".join(moras[:accent_type]) + "!" + "".join(moras[accent_type:])


def sapi_kana(reading_katakana, accent_type):
    """Azure's ja-JP sapi notation.  `'` = "Accent position" (Microsoft's word),
    placed AFTER the affected syllable; a trailing `+` = "Accent boundary",
    reported to read the word 平板.  BOTH UNVERIFIED -- see the harness."""
    moras = split_moras(reading_katakana)
    if accent_type <= 0 or accent_type > len(moras):
        return "".join(moras) + "+"
    return "".join(moras[:accent_type]) + "'" + "".join(moras[accent_type:])
