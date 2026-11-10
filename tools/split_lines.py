"""Split one batched TTS clip back into its lines, for tools/gemini_tts.mjs batched mode.

  python tools/split_lines.py <clip.wav> <lines.json> <out.json> [--model small.en]

lines.json: ["first line", "second line", ...] in the order they were sent.
out.json:   { "cuts": [ { "start", "end" } per line ], "score", "words", "matched", "worst": [...] }

Whisper transcribes the clip with word timings; the heard words are aligned to the script words
(difflib), and each line's span runs from its first matched word to its last. The cut between two
lines goes in the middle of the silence between them (refined to the quietest 10 ms there).
"""
import difflib, json, sys

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from asr_qc import norm_tokens, get_model, decode  # noqa: E402


def quietest(pcm, a, b, rate=16000):
    """Time of the quietest 10 ms window between a and b seconds."""
    import numpy as np
    i0, i1 = int(a * rate), int(b * rate)
    if i1 - i0 < 320:
        return (a + b) / 2
    seg = pcm[i0:i1] ** 2
    win = 160
    e = np.convolve(seg, np.ones(win), "valid")
    return a + (int(np.argmin(e)) + win // 2) / rate


def main():
    args = sys.argv[1:]
    model = "small.en"
    if "--model" in args:
        k = args.index("--model"); model = args[k + 1]; del args[k:k + 2]
    clip, lines_path, out_path = args
    lines = json.load(open(lines_path, encoding="utf-8"))
    pcm = decode(clip)
    dur = len(pcm) / 16000
    segs, _ = get_model(model).transcribe(pcm, language="en", word_timestamps=True, beam_size=5,
                                          condition_on_previous_text=False, vad_filter=False)
    heard = []
    for s in segs:
        for w in s.words:
            for t in norm_tokens(w.word):
                heard.append((t, w.start, w.end))
    exp, owner = [], []
    for k, line in enumerate(lines):
        for t in norm_tokens(line):
            exp.append(t); owner.append(k)
    sm = difflib.SequenceMatcher(a=exp, b=[h[0] for h in heard], autojunk=False)
    hit = {}
    for a, b, n in sm.get_matching_blocks():
        for j in range(n):
            hit[a + j] = b + j
    spans = []
    for k in range(len(lines)):
        idx = [hit[i] for i in range(len(exp)) if owner[i] == k and i in hit]
        n = sum(1 for o in owner if o == k)
        spans.append({"first": heard[min(idx)][1] if idx else None, "last": heard[max(idx)][2] if idx else None,
                      "matched": len(idx), "words": n})
    # Lines with no matched words borrow the gap between their neighbours.
    for k, s in enumerate(spans):
        if s["first"] is None:
            prev = next((spans[j]["last"] for j in range(k - 1, -1, -1) if spans[j]["last"] is not None), 0)
            nxt = next((spans[j]["first"] for j in range(k + 1, len(spans)) if spans[j]["first"] is not None), dur)
            s["first"], s["last"] = prev, nxt
    bounds = [0.0]
    for k in range(len(lines) - 1):
        a, b = spans[k]["last"], spans[k + 1]["first"]
        bounds.append(quietest(pcm, min(a, b), max(a, b)) if b > a else (a + b) / 2)
    bounds.append(dur)
    cuts = [{"start": round(bounds[k], 3), "end": round(bounds[k + 1], 3), "matched": s["matched"], "words": s["words"]}
            for k, s in enumerate(spans)]
    matched = sum(s["matched"] for s in spans)
    worst = sorted(range(len(lines)), key=lambda k: spans[k]["matched"] / max(spans[k]["words"], 1))[:3]
    out = {"cuts": cuts, "words": len(exp), "matched": matched, "score": round(matched / max(len(exp), 1), 3),
           "worst": [{"line": k, "text": lines[k], "matched": spans[k]["matched"], "words": spans[k]["words"]} for k in worst]}
    json.dump(out, open(out_path, "w", encoding="utf-8"), indent=1)
    print(json.dumps({"score": out["score"], "matched": matched, "words": len(exp), "worst": out["worst"]}))


if __name__ == "__main__":
    main()
