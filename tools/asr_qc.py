"""Listen-back check for tools/qc.mjs: transcribe an episode with Whisper and align it to the script.

  python tools/asr_qc.py <audio.mp3> <expected.json> <out.json> [--model small.en] [--cache <asr.json>]

expected.json: { "segments": [ { "i": 0, "voice": "bf_emma", "who": "narrator", "text": "..." }, ... ],
                 "names": ["Tobias", ...], "sayAs": { "Quay": ["key"] } }   # words the lexicon/bible pronounces specially
out.json:      { "wer", "words", "issues": [...], "segments": [ { i, start, end, wpm, rmsDb } ], "names": {...} }

The transcript is cached (keyed by the audio's size and mtime) so re-scoring is instant.
"""
import difflib, json, os, re, sys

NUMS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()


def norm_tokens(text):
    text = text.replace("’", "'").replace("‘", "'").lower()
    out = []
    for raw in re.split(r"[\s\-—–/]+", text):
        w = re.sub(r"[^a-z0-9']", "", raw).strip("'")
        if not w:
            continue
        if w.isdigit() and int(w) < len(NUMS):
            w = NUMS[int(w)]
        out.append(w)
    return out


_model = {}


def get_model(name):
    if name not in _model:
        from faster_whisper import WhisperModel
        _model[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return _model[name]


def decode(audio, start=None, dur=None):
    import subprocess, numpy as np
    cut = (["-ss", str(max(start, 0)), "-t", str(dur)] if start is not None else [])
    raw = subprocess.run(["ffmpeg", "-v", "error", *cut, "-i", audio, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def recheck(audio, model_name, start, expected_tokens):
    """Whisper sometimes skips a passage in a long file. Re-transcribe a short window; True if the words are there."""
    segs, _ = get_model(model_name).transcribe(decode(audio, start - 15, 40), language="en", beam_size=5,
                                               condition_on_previous_text=False)
    got = set(norm_tokens(" ".join(s.text for s in segs)))
    return sum(t in got for t in expected_tokens) >= 0.8 * len(expected_tokens)


def transcribe(audio, model_name, cache):
    st = os.stat(audio)
    key = f"{st.st_size}:{int(st.st_mtime)}:{model_name}"
    if cache and os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("key") == key:
            return data["words"]
    # Decode with ffmpeg (16 kHz mono float) rather than faster-whisper's PyAV path, which breaks across av versions.
    pcm16k = decode(audio)
    model = get_model(model_name)
    segs, _ = model.transcribe(pcm16k, language="en", word_timestamps=True, beam_size=5,
                               condition_on_previous_text=False, vad_filter=False)
    words = []
    for s in segs:
        for w in s.words:
            words.append({"w": w.word.strip(), "start": round(w.start, 2), "end": round(w.end, 2), "p": round(w.probability, 3)})
        print(f"  heard {s.end:6.0f}s", file=sys.stderr, flush=True)
    if cache:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w", encoding="utf-8") as f:
            json.dump({"key": key, "words": words}, f)
    return words


def main():
    args = sys.argv[1:]
    opt = lambda name, d=None: args[args.index(name) + 1] if name in args else d
    audio, expected_path, out_path = args[0], args[1], args[2]
    model_name, cache = opt("--model", "small.en"), opt("--cache")
    with open(expected_path, encoding="utf-8") as f:
        expected = json.load(f)

    # Expected tokens, each tagged with its segment.
    exp, exp_seg = [], []
    for seg in expected["segments"]:
        for t in norm_tokens(seg["text"]):
            exp.append(t)
            exp_seg.append(seg["i"])

    words = transcribe(audio, model_name, cache)
    heard, heard_idx = [], []  # token -> index into words
    for wi, w in enumerate(words):
        for t in norm_tokens(w["w"]):
            heard.append(t)
            heard_idx.append(wi)

    sm = difflib.SequenceMatcher(None, exp, heard, autojunk=False)
    seg_by_i = {s["i"]: s for s in expected["segments"]}
    names = {n.lower() for n in expected.get("names", [])}
    # Bible respellings: a name heard as its respelling ("quay" -> "key") was said right.
    say_as = {k.lower(): {v.lower() for v in vs} for k, vs in expected.get("sayAs", {}).items()}
    said_right = lambda e, h: h in say_as.get(e, set())
    issues, errors = [], 0
    seg_times = {}

    def t_at(j):
        j = min(max(j, 0), len(heard_idx) - 1)
        return words[heard_idx[j]]["start"]

    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                w = words[heard_idx[j1 + k]]
                s = seg_times.setdefault(exp_seg[i1 + k], [w["start"], w["end"]])
                s[0], s[1] = min(s[0], w["start"]), max(s[1], w["end"])
                if w["p"] < 0.05:
                    issues.append({"kind": "unclear", "time": w["start"], "seg": exp_seg[i1 + k],
                                   "expected": exp[i1 + k], "heard": w["w"], "p": w["p"]})
            continue
        e, h = " ".join(exp[i1:i2]), " ".join(heard[j1:j2])
        if e.replace(" ", "").replace("'", "") == h.replace(" ", "").replace("'", ""):
            continue  # "to day" vs "today"
        if i2 - i1 == j2 - j1 and all(said_right(exp[i1 + k], heard[j1 + k]) for k in range(i2 - i1)):
            continue
        ratio = difflib.SequenceMatcher(None, e.replace(" ", ""), h.replace(" ", "")).ratio()
        seg_i = exp_seg[min(i1, len(exp_seg) - 1)]
        is_name = any(t in names for t in exp[i1:i2])
        kind = {"replace": "misheard", "delete": "missing", "insert": "extra"}[op]
        if op == "delete" and i2 - i1 >= 5 and recheck(audio, model_name, t_at(j1 - 1), exp[i1:i2]):
            continue  # Whisper skipped it in the long pass; it's in the audio
        if op == "replace" and ratio >= 0.75:
            kind = "spelling"  # probably fine, ASR spelled it differently
        if kind != "spelling":
            errors += max(i2 - i1, j2 - j1)
        ctx_l = " ".join(exp[max(0, i1 - 5):i1])
        ctx_r = " ".join(exp[i2:i2 + 5])
        issues.append({"kind": kind, "time": t_at(j1 if j2 > j1 else j1 - 1), "seg": seg_i,
                       "voice": seg_by_i[seg_i]["voice"], "who": seg_by_i[seg_i]["who"],
                       "expected": e, "heard": h, "context": f"{ctx_l} [{e}] {ctx_r}".strip(), "name": is_name})

    # Name report: how each special word came back.
    name_report = {}
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        for k in range(i1, i2):
            if exp[k] in names:
                got = heard[j1 + (k - i1)] if op == "equal" else " ".join(heard[j1:j2]) or "(nothing)"
                if said_right(exp[k], got):
                    got = exp[k]
                name_report.setdefault(exp[k], {}).setdefault(got, 0)
                name_report[exp[k]][got] += 1

    # Per-segment pace and level.
    segments = []
    try:
        import soundfile as sf, numpy as np
        pcm, sr = sf.read(audio, dtype="float32", always_2d=True)
        pcm = pcm.mean(axis=1)
    except Exception:
        pcm, sr = None, None
    for seg in expected["segments"]:
        if seg["i"] not in seg_times:
            continue
        a, b = seg_times[seg["i"]]
        n = len(norm_tokens(seg["text"]))
        row = {"i": seg["i"], "voice": seg["voice"], "who": seg["who"], "start": a, "end": b,
               "wpm": round(n / max(b - a, 0.5) * 60) if n >= 6 else None}
        if pcm is not None:
            chunk = pcm[int(a * sr):int(b * sr)]
            if len(chunk):
                import numpy as np
                row["rmsDb"] = round(float(20 * np.log10(np.sqrt(np.mean(chunk ** 2)) + 1e-9)), 1)
        segments.append(row)

    out = {"model": model_name, "words": len(exp), "heardWords": len(heard),
           "wer": round(errors / max(len(exp), 1), 4), "issues": issues, "segments": segments, "names": name_report}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
