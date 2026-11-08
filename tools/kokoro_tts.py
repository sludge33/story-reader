"""Kokoro TTS backend for tools/narrate.mjs.

  python tools/kokoro_tts.py render  <job.json> <out.wav>
  python tools/kokoro_tts.py phonemes <job.json>          # prints {"word": "ipa", ...} as JSON

job.json:
  { "model": "...onnx", "voices": "...bin", "lang": "en-gb", "sampleRate": 24000,
    "lexicon": { "Odile": "/əʊdˈiːl/", "Harrow": "hair oh" },   # /IPA/ or a respelling to phonemize
    "segments": [ { "voice": "bf_emma", "text": "...", "speed": 0.95, "pauseAfter": 0.35 }, ... ],
    "words": ["Odile", ...] }                                     # phonemes mode only

A voice may be a blend: "bf_alice*0.6+bf_lily*0.4".
"""
import json, re, sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro


def load(job):
    return Kokoro(job["model"], job["voices"])


def voice_style(k, spec, cache={}):
    if spec in cache:
        return cache[spec]
    parts = []
    for part in spec.split("+"):
        name, _, weight = part.partition("*")
        parts.append((k.get_voice_style(name.strip()), float(weight) if weight else 1.0))
    total = sum(w for _, w in parts)
    style = sum(s * (w / total) for s, w in parts)
    cache[spec] = style
    return style


def lexicon_ipa(k, lexicon, lang):
    out = {}
    for word, say in lexicon.items():
        say = say.strip()
        out[word] = say.strip("/") if say.startswith("/") else k.tokenizer.phonemize(say, lang)
    return out


def phonemize(k, text, ipa, lang):
    """Phonemize text, swapping in lexicon IPA for whole words (and their possessives)."""
    if not ipa:
        return k.tokenizer.phonemize(text, lang)
    words = sorted(ipa, key=len, reverse=True)
    pattern = re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")(['’]s)?\b")
    pieces, pos = [], 0
    for m in pattern.finditer(text):
        before = text[pos:m.start()]
        if before.strip():
            pieces.append(k.tokenizer.phonemize(before, lang))
        word_ipa = ipa[m.group(1)]
        if m.group(2):
            word_ipa += "ɪz" if word_ipa.rstrip("ː").endswith(("s", "z", "ʃ", "ʒ")) else "z"
        pieces.append(word_ipa)
        pos = m.end()
    rest = text[pos:]
    if rest.strip():
        pieces.append(k.tokenizer.phonemize(rest, lang))
    return " ".join(p for p in pieces if p)


def render(job, out_path):
    k = load(job)
    lang = job.get("lang", "en-gb")
    ipa = lexicon_ipa(k, job.get("lexicon", {}), lang)
    sr = job.get("sampleRate", 24000)
    chunks, n = [], len(job["segments"])
    for i, seg in enumerate(job["segments"], 1):
        if seg.get("text", "").strip():
            phon = phonemize(k, seg["text"], ipa, lang)
            audio, sr = k.create(phon, voice=voice_style(k, seg["voice"]), speed=seg.get("speed", 1.0),
                                 lang=lang, is_phonemes=True)
            chunks.append(audio.astype(np.float32))
        pause = seg.get("pauseAfter", 0)
        if pause:
            chunks.append(np.zeros(int(sr * pause), dtype=np.float32))
        if i % 10 == 0 or i == n:
            print(f"  {i}/{n} segments", file=sys.stderr, flush=True)
    sf.write(out_path, np.concatenate(chunks), sr)


def phonemes(job):
    k = load(job)
    lang = job.get("lang", "en-gb")
    ipa = lexicon_ipa(k, job.get("lexicon", {}), lang)
    return {w: phonemize(k, w, ipa, lang) for w in job["words"]}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    mode, job_path = sys.argv[1], sys.argv[2]
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)
    if mode == "render":
        render(job, sys.argv[3])
    elif mode == "phonemes":
        print(json.dumps(phonemes(job), ensure_ascii=False))
    else:
        sys.exit(f"unknown mode {mode}")
