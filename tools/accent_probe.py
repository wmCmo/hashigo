#!/usr/bin/env python
"""Pitch-accent notation probe. Decides, by ear, whether Azure's sapi apostrophe
and Google's yomigana ^/! actually move the downstep in a ja-JP neural voice.

NOTHING IS SENT WITHOUT --go.  Without it this prints the exact request bodies
and exits.  Keys are read from the environment (or a .env file) by NAME ONLY and
are never printed, logged, or written to disk.

    # see what would be sent -- no network, no cost
    python tools/accent_probe.py probe --provider both

    # free, unmetered: which ja-JP voices exist, and which are male
    python tools/accent_probe.py voices --provider both --go

    # the real thing: 11 calls per provider, ~40 characters
    python tools/accent_probe.py probe --provider both --go --out build/accent-probe

    # 20 real cards from the deck.  Refuses more than 20.
    python tools/accent_probe.py cards --provider google --limit 20 --go \
        --db build/hashigo.db --out build/accent-cards

Env var names are yours; override them if .env spells them differently:
    --azure-key-env    default AZURE_SPEECH_KEY
    --azure-region-env default AZURE_SPEECH_REGION
    --google-key-env   default GOOGLE_TTS_API_KEY
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # cp932 console

HARD_CARD_CAP = 20          # he asked to start small; this enforces it


# --------------------------------------------------------------------------
# secrets: by name, never by value
# --------------------------------------------------------------------------
def load_dotenv(path: pathlib.Path) -> None:
    """Populate os.environ from .env without printing anything from it."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def secret(var: str) -> str:
    value = os.environ.get(var, "")
    if not value:
        sys.exit(
            f"missing {var}.\n"
            f"  Set it in the environment or in .env, or point at the right name with\n"
            f"  --azure-key-env / --azure-region-env / --google-key-env.\n"
            f"  This script never prints the value."
        )
    return value


# --------------------------------------------------------------------------
# notation.  Both helpers duplicated from tools/accent.py so this file runs
# standalone -- keep them in sync if you change the rule.
# --------------------------------------------------------------------------
SMALL = "ゃゅょぁぃぅぇぉャュョァィゥェォ"


def split_moras(kana: str) -> list[str]:
    out: list[str] = []
    for ch in kana:
        if ch in SMALL and out:
            out[-1] += ch
        else:
            out.append(ch)
    return out


def yomigana(reading: str, accent: int) -> str:
    """Google: ^ opens the pitch phrase, ! follows the mora carrying the drop."""
    m = split_moras(reading)
    if accent <= 0 or accent > len(m):
        return "^" + "".join(m)
    return "^" + "".join(m[:accent]) + "!" + "".join(m[accent:])


def sapi_kana(reading: str, accent: int) -> str:
    """Azure: ' = "Accent position", placed AFTER the affected syllable.
    Trailing + = "Accent boundary", reported to read the word 平板."""
    m = split_moras(reading)
    if accent <= 0 or accent > len(m):
        return "".join(m) + "+"
    return "".join(m[:accent]) + "'" + "".join(m[accent:])


# --------------------------------------------------------------------------
# the cases
# --------------------------------------------------------------------------
class Case:
    """text = what the listener should hear; word/reading/accent = the notation.
    scope 'word' wraps the word only and leaves the particle outside the tag;
    scope 'all' wraps word+particle together."""

    def __init__(self, name, text, word=None, reading=None, kata=None,
                 accent=None, scope="word", why=""):
        self.name, self.text, self.word = name, text, word
        self.reading, self.kata, self.accent = reading, kata, accent
        self.scope, self.why = scope, why

    @property
    def plain(self) -> bool:
        return self.word is None


PROBE_CASES = [
    # 1. What do the providers do UNAIDED?  Answers "asset or liability" for
    #    the 7,403 existing Nanami clips.
    Case("baseline-hashi1", "箸が", why="unaided: 箸 is 頭高(1)"),
    Case("baseline-hashi2", "橋が", why="unaided: 橋 is 尾高(2)"),
    Case("baseline-hana2",  "花が", why="unaided: 花 is 尾高(2)"),
    Case("baseline-hana0",  "鼻が", why="unaided: 鼻 is 平板(0)"),

    # 2. Same input, three notations.  THIS is the test.
    Case("hashi-1", "はしが", "はし", "はし", "ハシ", 1,
         why="drop after は -- 箸"),
    Case("hashi-2", "はしが", "はし", "はし", "ハシ", 2,
         why="drop after し, onto が -- 橋"),
    Case("hashi-0", "はしが", "はし", "はし", "ハシ", 0,
         why="NO drop -- 端.  55.2% of the deck is this case."),

    # 3. The pair that needs the particle to be audible at all.
    Case("hana-2", "はなが", "はな", "はな", "ハナ", 2, why="花"),
    Case("hana-0", "はなが", "はな", "はな", "ハナ", 0, why="鼻"),

    # 4. Does a word-final ! reach a particle OUTSIDE the tag?  Nobody has
    #    published an answer.
    Case("scope-out", "橋が", "橋", "はし", "ハシ", 2, scope="word",
         why="notation covers 橋 only; が is outside the element"),
    Case("scope-in",  "橋が", "橋が", "はしが", "ハシガ", 2, scope="all",
         why="notation covers 橋が together"),

    # 5. PHONETIC vs ORTHOGRAPHIC reading.  OpenJTalk hands back ー for long
    #    vowels (使命 -> シメー, not シメイ).  Google's 女王 -> じょおー example
    #    says they want the phonetic form; Azure's own ゴ'ウセ uses ウ, not ー.
    #    They may disagree.  UNVERIFIED, and it affects every long-vowel word.
    Case("long-phonetic", "使命が", "使命", "しめー", "シメー", 1,
         why="OpenJTalk's phonetic kana: long vowel as ー"),
    Case("long-ortho",    "使命が", "使命", "しめい", "シメイ", 1,
         why="orthographic kana: same word spelled しめい"),
]

TILDE_CASES = [
    Case("tilde-none", "なり",  why="control for the placeholder duration test"),
    Case("tilde-lead", "～なり", why="if this is longer, the ～ is being voiced"),
]


# --------------------------------------------------------------------------
# Azure
# --------------------------------------------------------------------------
AZURE_SSML = (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
    'xml:lang="ja-JP"><voice name="{voice}">{body}</voice></speak>'
)


def azure_body(case: Case, voice: str) -> str:
    if case.plain:
        body = case.text
    else:
        ph = sapi_kana(case.kata, case.accent)
        tag = f'<phoneme alphabet="sapi" ph="{ph}">{case.word}</phoneme>'
        tail = case.text[len(case.word):] if case.scope == "word" else ""
        body = tag + tail
    return AZURE_SSML.format(voice=voice, body=body)


def azure_call(ssml: str, key: str, region: str) -> bytes:
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            # PCM WAV, not mp3: this machine has no ffmpeg, and a measurable F0
            # contour beats a subjective listen. Same characters billed either way.
            # byte sizes stay comparable with blobs.byte_size.
            "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
            "User-Agent": "hashigo-accent-probe",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def azure_voices(key: str, region: str) -> list[dict]:
    req = urllib.request.Request(
        f"https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list",
        headers={"Ocp-Apim-Subscription-Key": key},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# --------------------------------------------------------------------------
# Google.  Path (a): SSML <phoneme alphabet="yomigana">.  Better documented
# than custom_pronunciations and where the 端/箸/橋 examples actually live.
# --------------------------------------------------------------------------
def google_payload(case: Case, voice: str) -> dict:
    if case.plain:
        inp = {"text": case.text}
    else:
        ph = yomigana(case.reading, case.accent)
        tail = case.text[len(case.word):] if case.scope == "word" else ""
        inp = {"ssml": f'<speak><phoneme alphabet="yomigana" ph="{ph}">'
                       f'{case.word}</phoneme>{tail}</speak>'}
    return {
        "input": inp,
        "voice": {"languageCode": "ja-JP", "name": voice},
        "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000},
    }


def google_payload_field(case: Case, voice: str) -> dict:
    """Path (b): the custom_pronunciations FIELD, for comparison.  Note the
    `pronunciations` ARRAY -- Google's own Chirp 3 HD example omits it and is
    malformed."""
    return {
        "input": {
            "text": case.text,
            "customPronunciations": {
                "pronunciations": [{
                    "phrase": case.word,
                    "phoneticEncoding": "PHONETIC_ENCODING_JAPANESE_YOMIGANA",
                    "pronunciation": yomigana(case.reading, case.accent),
                }]
            },
        },
        "voice": {"languageCode": "ja-JP", "name": voice},
        "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000},
    }


def google_call(payload: dict, key: str) -> bytes:
    import base64
    req = urllib.request.Request(
        f"https://texttospeech.googleapis.com/v1/text:synthesize?key={key}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return base64.b64decode(json.load(r)["audioContent"])


def google_voices(key: str) -> list[dict]:
    url = f"https://texttospeech.googleapis.com/v1/voices?languageCode=ja-JP&key={key}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)["voices"]


# --------------------------------------------------------------------------
# cards: 20 real head-words, derived with tools/accent.py
# --------------------------------------------------------------------------
def load_cards(db_path: str, limit: int) -> list[Case]:
    if limit > HARD_CARD_CAP:
        sys.exit(f"refusing --limit {limit}: the cap is {HARD_CARD_CAP}. Start small.")
    try:
        sys.path.insert(0, str(pathlib.Path(__file__).parent))
        from accent import derive          # noqa: PLC0415
        import pyopenjtalk                 # noqa: F401,PLC0415
    except ImportError as exc:
        sys.exit(f"cards mode needs tools/accent.py and pyopenjtalk(-plus): {exc}")

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """SELECT v.value AS val FROM card_field_values v
             JOIN cards c ON c.id = v.card_id
             JOIN templates t ON t.id = c.template_id
            WHERE v.field_id = 'name' AND t.name = '単語'
            ORDER BY c.id"""
    ).fetchall()

    out: list[Case] = []
    for row in rows:
        word = row["val"].strip()
        if not word:
            continue
        d = derive(word)
        if not d.get("ok"):
            continue                       # guarded / multi-phrase: review by hand
        kana = pyopenjtalk.g2p(word, kana=True)
        hira = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in kana)
        out.append(Case(f"card-{len(out):02d}-{word}", word + "が", word, hira, kana,
                        d["accent_type"],
                        why=f"{d['type']}({d['accent_type']}) / {d['bare_moras']} morae"))
        if len(out) >= limit:
            break
    return out


# --------------------------------------------------------------------------
def run(cases, provider, args, outdir: pathlib.Path | None):
    azure_key = azure_region = google_key = ""
    if args.go:
        if provider in ("azure", "both"):
            azure_key = secret(args.azure_key_env)
            azure_region = secret(args.azure_region_env)
        if provider in ("google", "both"):
            google_key = secret(args.google_key_env)

    for case in cases:
        print(f"\n=== {case.name}   {case.text!r}   {case.why}")
        jobs = []
        if provider in ("azure", "both"):
            ssml = azure_body(case, args.azure_voice)
            print(f"  azure  ssml: {ssml}")
            jobs.append(("azure", ssml,
                         lambda s=ssml: azure_call(s, azure_key, azure_region)))
        if provider in ("google", "both"):
            payload = google_payload(case, args.google_voice)
            print(f"  google json: {json.dumps(payload, ensure_ascii=False)}")
            jobs.append(("google", payload,
                         lambda p=payload: google_call(p, google_key)))
            if args.google_field and not case.plain:
                pf = google_payload_field(case, args.google_voice)
                print(f"  google json (custom_pronunciations field): "
                      f"{json.dumps(pf, ensure_ascii=False)}")
                jobs.append(("google-field", pf,
                             lambda p=pf: google_call(p, google_key)))

        if not args.go:
            continue
        for tag, _, call in jobs:
            try:
                audio = call()
            except urllib.error.HTTPError as exc:
                # Read the body: both providers put the real reason there, and
                # neither body contains the key.
                print(f"  {tag}: HTTP {exc.code} {exc.read()[:400].decode('utf-8', 'replace')}")
                continue
            except Exception as exc:                       # noqa: BLE001
                print(f"  {tag}: {type(exc).__name__}: {exc}")
                continue
            path = outdir / f"{case.name}.{tag}.wav"
            path.write_bytes(audio)
            print(f"  {tag}: {len(audio):,} bytes -> {path}")


def listen_checklist() -> None:
    print("""
LISTEN FOR, in this order:

 1. hashi-0 vs hashi-1 vs hashi-2 -- SAME input text, three notations.
    All three identical            -> the notation is IGNORED. Provider fails.
    All three different            -> honoured. Note WHICH mora drops in each.
 2. hashi-0 and hana-0 (平板).  Is there any drop at all?  There must not be.
    This is 55.2% of the deck and the single most important clip here.
 3. hana-2 vs hana-0.  Bare 花/鼻 are identical by construction, so if these
    differ, it is the particle carrying 花's drop -- which is the point.
 4. scope-out vs scope-in.  If scope-out has no drop on が, the notation must
    cover the particle, and every 尾高 request needs the particle inside it.
 5. baseline-*.  Are the UNAIDED clips right?  This is the asset-or-liability
    question for 7,403 existing Nanami clips, and four clips answer it.
 6. long-phonetic vs long-ortho.  OpenJTalk gives 使命 as シメー; the deck will
    be full of ー.  If only one of these is right, the derivation must convert.
 7. tilde-none vs tilde-lead.  Compare BYTE SIZES printed above, then listen.
    Near-equal -> the placeholder is silent.  Longer -> it is being voiced,
    and stripping it changes the audio on 21 cards.

Then, and only then, `cards --limit 20`.""")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("mode", choices=["probe", "cards", "voices"])
    p.add_argument("--provider", choices=["azure", "google", "both"], default="both")
    p.add_argument("--go", action="store_true",
                   help="actually call the API. Without this, nothing is sent.")
    p.add_argument("--out", default="build/accent-probe")
    p.add_argument("--db", default="build/hashigo.db")
    p.add_argument("--limit", type=int, default=HARD_CARD_CAP)
    p.add_argument("--azure-voice", default="ja-JP-NanamiNeural")
    p.add_argument("--google-voice", default="ja-JP-Neural2-B")
    p.add_argument("--google-field", action="store_true",
                   help="also try the custom_pronunciations FIELD, not just SSML")
    p.add_argument("--azure-key-env", default="AZURE_SPEECH_KEY")
    p.add_argument("--azure-region-env", default="AZURE_SPEECH_REGION")
    p.add_argument("--google-key-env", default="GOOGLE_TTS_API_KEY")
    p.add_argument("--env-file", default=".env")
    args = p.parse_args()

    load_dotenv(pathlib.Path(args.env_file))

    if args.mode == "voices":
        if not args.go:
            sys.exit("voices needs --go. The list endpoints are free and unmetered.")
        if args.provider in ("azure", "both"):
            print("== Azure ja-JP ==")
            for v in azure_voices(secret(args.azure_key_env),
                                  secret(args.azure_region_env)):
                if v.get("Locale") == "ja-JP":
                    print(f"  {v['ShortName']:<40} {v.get('Gender'):<8} {v.get('VoiceType')}")
        if args.provider in ("google", "both"):
            print("== Google ja-JP ==")
            for v in google_voices(secret(args.google_key_env)):
                print(f"  {v['name']:<40} {v.get('ssmlGender')}")
        return

    outdir = pathlib.Path(args.out)
    if args.go:
        outdir.mkdir(parents=True, exist_ok=True)

    if args.mode == "probe":
        cases = PROBE_CASES + TILDE_CASES
    else:
        cases = load_cards(args.db, args.limit)
        print(f"{len(cases)} cards (cap {HARD_CARD_CAP})")

    if not args.go:
        print("\nDRY RUN -- nothing sent. Add --go when you are ready.\n")

    run(cases, args.provider, args, outdir if args.go else None)

    if args.mode == "probe":
        listen_checklist()


if __name__ == "__main__":
    main()
