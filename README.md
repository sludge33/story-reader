# Story Reader

A public listening site for stories from [story-engine](https://github.com/sludge33/story-engine). Static HTML/JS, no build step, hosted on GitHub Pages.

- **Library → series → episode.** Each episode page shows the full text with the current paragraph highlighted as it plays.
- **Audio:** episodes with an MP3 (narrated here with `tools/narrate.mjs`) play it. Episodes without one are narrated by the listener's browser voice, sentence by sentence. Edge's "Natural" voices and Chrome's "Google" voices sound best.
- **Remembers your place** per episode in the browser (speed and voice too).
- Keyboard: `space`/`k` play/pause, `j`/`l` back/forward.

## Publish new episodes

From this repo, with story-engine checked out next to it:

```bash
node tools/import.mjs --from ../story-engine
git add content audio && git commit -m "Import episodes" && git push
```

The importer rewrites `content/` from scratch each run. What it includes:

| Rule | Why |
| --- | --- |
| Skips any series whose home platform is `exclusive` in story-engine's `config/platforms.json` (Pocket FM) | Pocket FM contracts are exclusive and perpetual; those series can never appear here |
| Takes an episode once it is approved (status `approved`/`published`, or at or before `lastApproved` in `series/index.json`) | Drafts and episodes in review stay private |
| Uses `audio/<series>/<code>.mp3` when it exists (else copies a story-engine `platformCuts.audioPath`, if any) | Otherwise the site uses browser narration |
| Adds `audioVersions` from `audio/<series>/<code>.versions.json` when it exists | The player shows a Version picker (first entry is the default; `endsAtBlock` marks a sample that stops early) |

Use `--dry-run` to see what would be imported without writing anything. story-engine is read-only from this repo: nothing here writes to it.

## Narrate an episode

Local Kokoro TTS (Apache-2.0, free). Needs Python with `kokoro-onnx`, `soundfile` and `numpy`, plus `ffmpeg`/`ffprobe` on PATH, and the model paths in `.env` (gitignored):

```
KOKORO_MODEL=<path to kokoro .onnx>
KOKORO_VOICES=<path to voices .bin>
```

1. Cast the series once in `casting/<series>/cast.json`: `voices` maps each story-engine bible character id to a Kokoro voice; `lexicon` fixes names the engine mispronounces.
2. `node tools/narrate.mjs <series> <code> --dry-run` lists every quoted line with its speaker and voice. Fix wrong speakers (and add walk-on voices) in `casting/<series>/<code>.json`.
3. `node tools/narrate.mjs <series> <code>` writes `audio/<series>/<code>.mp3` and a `<code>.json` sidecar with its length. Each segment is level-matched (`levelMatch`) and the mix is mastered to -16 LUFS, -1.5 dBTP (`master`).
4. `node tools/qc.mjs <series> <code>` checks the MP3 (below). Fix what it flags, re-render, and re-check until it passes. Then run the importer and commit as above.

Engine settings (narrator voice, speeds, pauses, level matching, mastering, bitrate) are in `config/tts.json`.

## Audio quality check

`tools/qc.mjs` writes `qc/<series>/<code>.md`, a report to listen along with, and `qc/<series>/<code>.json`, and exits 1 if a gate fails. Gates are in `config/qc.json`. The listen-back step needs `pip install faster-whisper`; the Whisper model (small.en, about 480 MB) downloads on first use, and transcripts are cached in `.cache/`. Use `--no-asr` to skip it.

| Layer | What it checks | Fix with |
| --- | --- | --- |
| Script lint (before audio) | Digits, abbreviations, markup, symbols, unpaired quotes; capitalised words not in the lexicon | Lexicon, or flag the wording to story-engine |
| Signal | Loudness (-16 LUFS ±1), true peak (≤ -1 dBTP), clipped samples, dead air over 2.5 s | `master` in `config/tts.json`; re-render |
| Listen-back (Whisper) | Word accuracy against the script, with a timestamped list of misheard, missing and extra words | Listen at the timestamp; fix the lexicon or casting |
| Names | How each bible name came back; the bible's respelling counts as said right ("Quay" heard as "key") | `lexicon` in `casting/<series>/cast.json` |
| Voices | Overall pace (145–170 wpm), speaking rate and level per voice (spread ≤ 3 dB) | `speed` and `levelMatch` in `config/tts.json` |

Speaker attribution isn't something Whisper can check: review it with `narrate.mjs --dry-run`. Whisper also misses tone, so the report is a listening guide, not a replacement for one listen-through.

## Preview locally

```bash
node tools/serve.mjs
```

Then open http://localhost:4173.

## GitHub Pages setup (once)

Repo **Settings → Pages → Build and deployment**: Source "GitHub Actions". `.github/workflows/pages.yml` then deploys every push to `main` (or run it by hand from the Actions tab). The site is at https://sludge33.github.io/story-reader/.

## Layout

| Path | What |
| --- | --- |
| `index.html`, `assets/` | The site |
| `content/catalog.json` | Series and episode list (generated) |
| `content/<series>/<code>.json` | One episode's text blocks (generated) |
| `audio/<series>/<code>.mp3`, `.json` | Episode audio and its length (generated by `tools/narrate.mjs`) |
| `casting/<series>/` | Voice casting, lexicon and per-episode speaker fixes |
| `config/tts.json` | Narration engine settings |
| `config/qc.json`, `qc/<series>/` | Audio quality gates and per-episode QC reports |
| `tools/qc.mjs`, `tools/asr_qc.py` | Audio quality check (Node driver, Whisper listen-back) |
| `tools/import.mjs` | story-engine → content importer |
| `tools/narrate.mjs`, `tools/kokoro_tts.py` | Narration (Node driver, Python Kokoro backend) |
| `tools/serve.mjs` | Local preview server |
