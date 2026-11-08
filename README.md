# Story Reader

A public listening site for stories from [story-engine](https://github.com/sludge33/story-engine). Static HTML/JS, no build step, hosted on GitHub Pages.

- **Library → series → episode.** Each episode page shows the full text with the current paragraph highlighted as it plays.
- **Audio:** episodes with an MP3 (story-engine's `platformCuts.audioPath`) play it. Episodes without one are narrated by the listener's browser voice, sentence by sentence. Edge's "Natural" voices and Chrome's "Google" voices sound best.
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
| Copies `platformCuts.audioPath` into `audio/<series>/<code>.*` when present | Otherwise the site uses browser narration |

Use `--dry-run` to see what would be imported without writing anything.

## Preview locally

```bash
node tools/serve.mjs
```

Then open http://localhost:4173.

## GitHub Pages setup (once)

Repo **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`. The site appears at https://sludge33.github.io/story-reader/.

## Layout

| Path | What |
| --- | --- |
| `index.html`, `assets/` | The site |
| `content/catalog.json` | Series and episode list (generated) |
| `content/<series>/<code>.json` | One episode's text blocks (generated) |
| `audio/` | Episode audio, when it exists (generated) |
| `tools/import.mjs` | story-engine → content importer |
| `tools/serve.mjs` | Local preview server |
