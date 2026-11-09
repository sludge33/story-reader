#!/usr/bin/env node
// Pull approved episodes from a story-engine checkout into content/ (and audio/).
//
//   node tools/import.mjs [--from ../story-engine] [--dry-run]
//
// Rules:
//   - A series whose home platform is exclusive in story-engine's config/platforms.json
//     (Pocket FM) is never imported. Exclusive contracts forbid cross-posting.
//   - An episode is imported once it is approved: package status "approved" or "published",
//     or its code is at or before the series' lastApproved in series/index.json.
//   - Audio: audio/<series>/<code>.mp3 made here by tools/narrate.mjs wins (length from its
//     .json sidecar). Otherwise a story-engine platformCuts.audioPath is copied in. Otherwise
//     the site narrates the text in the browser. An optional audio/<series>/<code>.versions.json
//     ({ versions: [{ id, label, src, durationSec, endsAtBlock? }] }) adds a version picker;
//     endsAtBlock marks a sample that stops at that block.
//   - story-engine is read-only: this script never writes there.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const engine = path.resolve(repo, opt("--from", "../story-engine"));
const dryRun = flag("--dry-run");
const WORDS_PER_MINUTE = 150;

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (p) => fs.existsSync(p);
const log = (...m) => console.log(...m);
const warn = (...m) => console.warn("  ! " + m.join(" "));

if (!exists(path.join(engine, "series", "index.json"))) {
  console.error(`No story-engine found at ${engine} (missing series/index.json). Pass --from <path>.`);
  process.exit(1);
}

const index = readJson(path.join(engine, "series", "index.json"));
const platforms = readJson(path.join(engine, "config", "platforms.json"));

// Concept cards hold the logline; index them by id once.
const concepts = new Map();
const ideasDir = path.join(engine, "ideas");
if (exists(ideasDir)) {
  for (const cycle of fs.readdirSync(ideasDir)) {
    const dir = path.join(ideasDir, cycle);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const data = readJson(path.join(dir, f));
        for (const card of data.cards ?? []) if (card.id) concepts.set(card.id, card);
      } catch {
        /* not a card file */
      }
    }
  }
}

// Script markdown -> blocks the player can narrate and highlight.
function parseScript(md) {
  const blocks = [];
  for (const chunk of md.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const text = chunk.replace(/\s*\n\s*/g, " ").trim();
    if (!text) continue;
    if (/^(\*\s*){3,}$|^-{3,}$|^#{1,6}\s*$/.test(text)) blocks.push({ type: "break" });
    else if (/^#{1,6}\s/.test(text)) blocks.push({ type: "heading", text: text.replace(/^#+\s*/, "") });
    else blocks.push({ type: "p", text });
  }
  return blocks;
}

const contentDir = path.join(repo, "content");
const audioDir = path.join(repo, "audio");
const catalog = { generatedAt: new Date().toISOString(), series: [] };
const written = [];

for (const s of index.series ?? []) {
  const id = s.seriesId;
  const rule = platforms[s.homePlatform];
  log(`${id} (${s.homePlatform})`);
  if (rule?.exclusive) {
    log(`  skipped: ${s.homePlatform} is exclusive, never cross-posted`);
    continue;
  }
  const seriesDir = path.join(engine, "series", id);
  const bible = exists(path.join(seriesDir, "bible.json")) ? readJson(path.join(seriesDir, "bible.json")) : {};
  const concept = concepts.get(s.conceptId ?? bible.conceptId) ?? {};

  // Episode titles come from season beat sheets.
  const titles = new Map();
  const seasonsDir = path.join(seriesDir, "seasons");
  if (exists(seasonsDir)) {
    for (const season of fs.readdirSync(seasonsDir)) {
      const beats = path.join(seasonsDir, season, "beats.json");
      if (exists(beats)) for (const ep of readJson(beats).episodes ?? []) if (ep.title) titles.set(ep.code, ep.title);
    }
  }

  const episodesDir = path.join(seriesDir, "episodes");
  const codes = exists(episodesDir) ? fs.readdirSync(episodesDir).filter((c) => /^S\d{2}E\d{3}$/.test(c)).sort() : [];
  const episodes = [];

  for (const code of codes) {
    const pkgPath = path.join(episodesDir, code, "package.json");
    if (!exists(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    const approved =
      ["approved", "published"].includes(pkg.status) || (s.lastApproved && code <= s.lastApproved);
    if (!approved) {
      log(`  ${code}: not approved yet (${pkg.status}), skipped`);
      continue;
    }
    const scriptPath = path.join(engine, pkg.scriptPath ?? path.join("series", id, "episodes", code, "script.md"));
    if (!exists(scriptPath)) {
      warn(`${code}: script missing at ${scriptPath}, skipped`);
      continue;
    }
    const blocks = parseScript(fs.readFileSync(scriptPath, "utf8"));
    const words = pkg.wordCount ?? blocks.reduce((n, b) => n + (b.text?.split(/\s+/).length ?? 0), 0);
    const title = pkg.platformCuts?.title ?? titles.get(code) ?? code;

    let audio = null;
    let narrated = null;
    const src = pkg.platformCuts?.audioPath;
    const local = `audio/${id}/${code}.mp3`;
    if (exists(path.join(repo, local))) {
      audio = local;
      const meta = path.join(repo, "audio", id, `${code}.json`);
      if (exists(meta)) narrated = readJson(meta);
    } else if (src) {
      const abs = path.resolve(engine, src);
      if (exists(abs)) {
        const rel = `audio/${id}/${code}${path.extname(abs)}`;
        if (!dryRun) {
          fs.mkdirSync(path.join(audioDir, id), { recursive: true });
          fs.copyFileSync(abs, path.join(repo, rel));
        }
        audio = rel;
      } else warn(`${code}: audioPath ${src} not found, using browser narration`);
    }

    const durationSec = narrated?.durationSec ?? pkg.platformCuts?.durationSec ?? Math.round((words / WORDS_PER_MINUTE) * 60);
    const episode = {
      code,
      title,
      blurb: pkg.platformCuts?.blurb ?? null,
      wordCount: words,
      durationSec,
      audio,
      publishedAt: pkg.publishedAt ?? null,
    };
    episodes.push(episode);
    // Optional extra audio versions (e.g. another engine's sample): audio/<series>/<code>.versions.json.
    const versionsPath = path.join(repo, "audio", id, `${code}.versions.json`);
    const audioVersions = audio && exists(versionsPath) ? readJson(versionsPath).versions : null;
    written.push({
      file: path.join(contentDir, id, `${code}.json`),
      data: { seriesId: id, seriesTitle: bible.title ?? s.title, ...episode, ...(audioVersions ? { audioVersions } : {}), blocks },
    });
    log(`  ${code} "${title}": ${words} words, ${audio ? "audio" : "browser narration"}`);
  }

  if (!episodes.length) {
    log("  no approved episodes, series not listed");
    continue;
  }
  catalog.series.push({
    id,
    title: bible.title ?? s.title,
    logline: concept.logline ?? null,
    hook: concept.hookPromise ?? null,
    genre: concept.genre ?? null,
    contentRating: bible.contentRating ?? null,
    season: s.season ?? 1,
    stage: s.stage ?? null,
    episodes,
  });
}

if (dryRun) {
  log(`\nDry run: would write ${written.length} episode(s) across ${catalog.series.length} series.`);
  process.exit(0);
}

fs.rmSync(contentDir, { recursive: true, force: true });
for (const { file, data } of written) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
fs.mkdirSync(contentDir, { recursive: true });
fs.writeFileSync(path.join(contentDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
log(`\nWrote ${written.length} episode(s) across ${catalog.series.length} series to content/.`);
