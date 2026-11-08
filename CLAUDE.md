# Story Reader

Public listening site for stories from story-engine (`../story-engine`). See README.md.

## Hard rule: story-engine is read-only

Never create, edit, move or delete anything under `../story-engine`, and never commit there. Read whatever you need from it (scripts, bibles, `series/index.json`, `config/`), but everything this repo produces lives in this repo:

- Narration code and settings: `tools/narrate.mjs`, `tools/kokoro_tts.py`, `config/tts.json`, `.env` (gitignored).
- Voice casting and pronunciations: `casting/<series>/cast.json`, keyed by the bible's character ids. Speaker fixes and walk-on voices: `casting/<series>/<code>.json`.
- Audio: `audio/<series>/<code>.mp3` plus its `<code>.json` sidecar.

If a story-engine file looks wrong or is missing something you need (a bible field, a schema change, an episode status), stop and tell Ben. Don't fix it from here.
