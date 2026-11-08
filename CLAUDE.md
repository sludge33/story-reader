# Story Reader

Public listening site for stories from story-engine (`../story-engine`). See README.md.

## Hard rule: story-reader never writes into story-engine

Data flows one way. This repo's tools and work read `../story-engine` (scripts, bibles, `series/index.json`, `config/`) but never create, edit or delete anything there. Everything this repo produces lives in this repo:

- Narration code and settings: `tools/narrate.mjs`, `tools/kokoro_tts.py`, `config/tts.json`, `.env` (gitignored).
- Voice casting and pronunciations: `casting/<series>/cast.json`, keyed by the bible's character ids. Speaker fixes and walk-on voices: `casting/<series>/<code>.json`.
- Audio: `audio/<series>/<code>.mp3` plus its `<code>.json` sidecar.

If story-reader work seems to need a change in story-engine (a bible field, a schema change, an episode status), stop and tell Ben rather than patching it from here. A session doing story-engine's own work follows story-engine's rules (`../story-engine/CLAUDE.md`).
