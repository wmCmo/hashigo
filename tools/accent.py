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


# ---------------------------------------------------------------------------
# Placeholders, the multi-phrase rule, and readings.
#
# Everything below implements what notes/pitch-accent-pipeline.md SPECIFIES and
# accent.py did not yet DO: derive() refused every multi-phrase entry with
# "apply the rule to the LAST phrase only" and left the caller to do it.
# ---------------------------------------------------------------------------

# THREE tilde codepoints and TWO ellipsis spellings are in use, measured by an
# exhaustive codepoint census over 3,860 values -- not by a regex, because a
# regex for `～〜...` is exactly what missed the single ASCII tilde in
# `~に越したことはない` and produced a count of 20 instead of 21.
PLACEHOLDERS = ("～", "〜", "~", "...", "…")

# Measured: a LEADING placeholder contributes no phoneme yet flips `なり` from
# accent 2 to accent 1, because the unknown symbol changes how the following
# morpheme is tagged. A MEDIAL one becomes a `pau` and splits breath groups. So
# it corrupts the derivation either way and comes off before analysis -- while
# staying in the DISPLAYED text, which is authored and verbatim by decision.
def split_placeholders(text):
    """Segments of `text` between placeholders, empties dropped.

    Returns the segmentation the notation wants: one `^` per surviving segment.
    The placeholder positions are better phrase boundaries than the analyser's
    own guesses, which is the whole reason to split here rather than strip and
    re-analyse.
    """
    out, current = [], text
    for mark in PLACEHOLDERS:
        current = current.replace(mark, "\x00")
    for piece in current.split("\x00"):
        piece = piece.strip()
        if piece:
            out.append(piece)
    return out


def has_placeholder(text):
    return any(mark in text for mark in PLACEHOLDERS)


def reading_of(text):
    """Katakana reading, as the analyser reads it. '' when it yields nothing."""
    try:
        return pyopenjtalk.g2p(text, kana=True) or ""
    except Exception:                      # noqa: BLE001 - analyser can refuse
        return ""


def derive_phrase_list(word, probe="が"):
    """The full rule, including the multi-phrase case.

    MEASURED (notes §3): the probe touches only the LAST accent phrase -- across
    空気を読む, 気を配る, にもかかわらず, ～なり～なり and ...は...に限る every
    leading phrase's (morae, accent) came back byte-identical and only the final
    one changed. So: analyse bare, take every phrase but the last verbatim, and
    apply the probe rule to the last one only.

    `basis` says which branch produced the answer, because a single-phrase probe
    result and a multi-phrase one do not deserve the same confidence and a column
    that conflates them is a number without a basis.
    """
    bare = phrases(word)
    if not bare:
        return {"word": word, "ok": False, "basis": "guarded",
                "reason": "analyser produced no accent phrase"}

    probed = phrases(word + probe)
    if len(probed) != len(bare):
        # The probe changed the SEGMENTATION, not just the last phrase. Refuse
        # rather than guess which phrase to trust.
        return {"word": word, "ok": False, "basis": "guarded", "guarded": True,
                "bare": bare, "probed": probed,
                "reason": "probe changed the phrase count; manual review"}

    last_bare_moras, _ = bare[-1]
    last_probed_moras, last_probed_accent = probed[-1]
    if last_probed_moras != last_bare_moras + 1:
        return {"word": word, "ok": False, "basis": "guarded", "guarded": True,
                "bare": bare, "probed": probed,
                "reason": "probe changed the reading; manual review"}

    name, atype = classify(last_bare_moras, last_probed_moras, last_probed_accent)
    if name == "不明":
        return {"word": word, "ok": False, "basis": "guarded",
                "bare": bare, "probed": probed,
                "reason": "accent position past the word; manual review"}

    # Leading phrases keep their OWN bare accent: they are already followed by
    # material inside their own phrase, so the bare-word problem does not arise
    # for them and no probe is needed.
    out_phrases = [list(p) for p in bare[:-1]] + [[last_bare_moras, atype]]
    return {
        "word": word,
        "ok": True,
        "guarded": False,
        "basis": "probe" if len(bare) == 1 else "multi-phrase",
        "bare": bare,
        "probed": probed,
        # The TYPE names the last phrase, which is the one being drilled. For a
        # multi-phrase entry that is a statement about the final phrase and the
        # `basis` column says so -- it is not a label for the whole string.
        "type": name,
        "accent_type": atype,
        "phrases": out_phrases,
    }


def derive_value(value, probe="が"):
    """Derive for one AUTHORED field value, placeholders and all.

    The authored value is what is on the card; the analyser must never see the
    placeholders. Segments are derived independently and reported together, so a
    caller can emit one `^` per segment.
    """
    segments = split_placeholders(value)
    if not segments:
        return {"value": value, "ok": False, "basis": "guarded",
                "reason": "nothing left after removing placeholders"}
    derived = [derive_phrase_list(segment, probe) for segment in segments]
    ok = all(d.get("ok") for d in derived)
    phrase_list = []
    for d in derived:
        phrase_list.extend(d.get("phrases") or [])
    return {
        "value": value,
        "analysed": segments,
        "had_placeholder": has_placeholder(value),
        "ok": ok,
        "guarded": any(d.get("guarded") for d in derived),
        # One segment: its own basis. Several: the notation spans placeholders.
        "basis": derived[0]["basis"] if len(derived) == 1 else ("multi-phrase" if ok else "guarded"),
        "type": derived[-1].get("type") if ok else None,
        "accent_type": derived[-1].get("accent_type") if ok else None,
        "phrases": phrase_list if ok else [],
        "reading": "".join(reading_of(s) for s in segments),
        "segments": derived,
        "reason": next((d["reason"] for d in derived if d.get("reason")), None),
    }
