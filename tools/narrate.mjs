#!/usr/bin/env node
// Narrate an approved story-engine episode to MP3 with Kokoro (local, free; see config/tts.json).
//
//   node tools/narrate.mjs <seriesId> <code> [--from ../story-engine] [--dry-run] [--force]
//
// story-engine is READ-ONLY here. From it: the script, package.json (status, title), the bible
// (character ids, names, pronunciation respellings), series/index.json, config/platforms.json
// and config/caps.json (audio cost cap).
// From this repo: config/tts.json, casting/<id>/cast.json (voices by bible character id, lexicon)
// and casting/<id>/<code>.json (optional: walk-on voices, speaker fixes).
// Writes   audio/<id>/<code>.mp3 and audio/<id>/<code>.json ({ durationSec, voiceUsd, engine }),
//          which tools/import.mjs picks up.
//
// --dry-run prints every quoted line with the speaker it was given and the pronunciations,
// then stops. Fix wrong speakers in casting/<id>/<code>.json: { "speakers": { "<quote #>": "<cast id>" } }.
// Speaker rules, in order: a cast name in the paragraph's narration; a he/she that matches
// one of the last two speakers; otherwise turn-taking (the speaker before last).

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const QUOTE = /["“”]([^"“”]*)["“”]/g;
const SCENE_BREAK = /^\s*(\*\s*){3,}$/;

/** Split a script into paragraphs; each is narration and quote parts in order, or a scene break. */
export function parseScript(md) {
  const paras = [];
  for (const block of md.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const text = block.replace(/\s*\n\s*/g, " ").trim();
    if (!text || /^#/.test(text)) continue;
    if (SCENE_BREAK.test(text)) { paras.push({ sceneBreak: true }); continue; }
    const parts = [];
    let pos = 0;
    for (const m of text.matchAll(QUOTE)) {
      if (m.index > pos) parts.push({ kind: "narration", text: text.slice(pos, m.index) });
      parts.push({ kind: "quote", text: m[1] });
      pos = m.index + m[0].length;
    }
    if (pos < text.length) parts.push({ kind: "narration", text: text.slice(pos) });
    paras.push({ parts: parts.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text) });
  }
  return paras;
}

/** "bf_emma" -> "female"; blends use their first voice. */
export const genderOf = (voice) => (/^.f_/.test(voice ?? "") ? "female" : /^.m_/.test(voice ?? "") ? "male" : null);

/**
 * Give every quote a speaker. cast: [{ id, voice, names: [...] }]. overrides: { "<quote #>": id }.
 * Mutates quote parts with { n, speaker, why } and returns them in order.
 */
export function attribute(paras, cast, overrides = {}) {
  const quotes = [];
  let last = null, prev = null;
  const byId = new Map(cast.map((c) => [c.id, c]));
  const names = cast.flatMap((c) => c.names.map((name) => ({ id: c.id, re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") })));
  for (const para of paras) {
    if (para.sceneBreak) { last = prev = null; continue; }
    const qs = para.parts.filter((p) => p.kind === "quote");
    if (!qs.length) continue;
    const narration = para.parts.filter((p) => p.kind === "narration").map((p) => p.text).join(" ");
    let speaker = null, why = "";
    let best = Infinity;
    for (const n of names) {
      const m = narration.match(n.re);
      if (m && m.index < best) { best = m.index; speaker = n.id; why = "named"; }
    }
    if (!speaker) {
      const pron = narration.match(/\b(he|she)\b/i);
      const g = pron && (pron[1].toLowerCase() === "he" ? "male" : "female");
      const recent = [last, prev].filter(Boolean);
      const hit = g && recent.find((id) => genderOf(byId.get(id)?.voice) === g);
      if (hit) { speaker = hit; why = `pronoun ${pron[1].toLowerCase()}`; }
    }
    if (!speaker) { speaker = prev ?? last ?? "narrator"; why = "turn-taking"; }
    for (const q of qs) {
      q.n = quotes.length + 1;
      q.speaker = overrides[q.n] ?? speaker;
      q.why = overrides[q.n] ? "override" : why;
      quotes.push(q);
    }
    const final = qs[qs.length - 1].speaker;
    if (final !== last) { prev = last; last = final; }
  }
  return quotes;
}

/** Make text speakable: ALL-CAPS words to Title case, dashes to pauses. */
export function speakable(text) {
  return text
    .replace(/\b([A-Z][A-Z']{1,})\b/g, (w) => w[0] + w.slice(1).toLowerCase())
    .replace(/\s*[—–]\s*$/, "...")
    .replace(/\s*[—–]\s*/g, ", ");
}

/** Turn attributed paragraphs into TTS segments (adjacent same-voice parts merged). */
export function segments(paras, voiceOf, cfg) {
  const segs = [];
  const push = (voice, text, speed, pauseAfter) => {
    const prevSeg = segs[segs.length - 1];
    if (prevSeg && prevSeg.voice === voice && prevSeg.speed === speed && prevSeg.text && prevSeg.pauseAfter <= cfg.pauses.segment) {
      prevSeg.text += " " + text; prevSeg.pauseAfter = pauseAfter; return;
    }
    segs.push({ voice, text, speed, pauseAfter });
  };
  for (const para of paras) {
    if (para.sceneBreak) { if (segs.length) segs[segs.length - 1].pauseAfter = cfg.pauses.sceneBreak; continue; }
    para.parts.forEach((p, i) => {
      const isQuote = p.kind === "quote";
      const voice = isQuote ? voiceOf(p.speaker) : cfg.narratorVoice;
      const pause = i === para.parts.length - 1 ? cfg.pauses.paragraph : cfg.pauses.segment;
      push(voice, speakable(p.text), isQuote ? cfg.speed.dialogue : cfg.speed.narration, pause);
    });
  }
  return segs;
}

function loadEnv(root) {
  const p = join(root, ".env");
  if (existsSync(p)) process.loadEnvFile(p);
}

function main(argv) {
  const flag = (f) => argv.includes(f);
  const fromIdx = argv.indexOf("--from");
  const args = argv.filter((a, i) => !a.startsWith("--") && (fromIdx < 0 || i !== fromIdx + 1));
  const repo = resolve(here, "..");
  const engine = resolve(repo, fromIdx >= 0 ? argv[fromIdx + 1] : "../story-engine");
  const [seriesId, code] = args;
  if (!seriesId || !code) { console.error("usage: node tools/narrate.mjs <seriesId> <code> [--from ../story-engine] [--dry-run] [--force]"); process.exit(2); }
  if (!existsSync(join(engine, "series", "index.json"))) { console.error(`No story-engine found at ${engine}. Pass --from <path>.`); process.exit(2); }
  loadEnv(repo);

  const cfg = readJson(join(repo, "config", "tts.json"));
  const caps = readJson(join(engine, "config", "caps.json"));
  const platforms = readJson(join(engine, "config", "platforms.json"));
  const seriesDir = join(engine, "series", seriesId);
  const epDir = join(seriesDir, "episodes", code);
  const pkg = readJson(join(epDir, "package.json"));
  const bible = readJson(join(seriesDir, "bible.json"));
  const entry = readJson(join(engine, "series", "index.json")).series.find((s) => s.seriesId === seriesId);
  const castDir = join(repo, "casting", seriesId);
  const casting = existsSync(join(castDir, "cast.json")) ? readJson(join(castDir, "cast.json")) : {};
  const outDir = join(repo, "audio", seriesId);

  if (platforms[bible.homePlatform]?.format?.includes("Pocket FM narrates")) {
    console.error(`${seriesId} is a ${bible.homePlatform} series; Pocket FM narrates its own. Not narrating.`); process.exit(1);
  }
  const approved = ["approved", "published"].includes(pkg.status) || (entry?.lastApproved && code <= entry.lastApproved);
  if (!approved && !flag("--force")) { console.error(`${code} is not approved (status ${pkg.status}). Use --force to narrate anyway.`); process.exit(1); }

  const ep = existsSync(join(castDir, `${code}.json`)) ? readJson(join(castDir, `${code}.json`)) : {};
  const lexicon = casting.lexicon ?? {};

  const cast = bible.characters.map((c) => {
    const parts = c.name.split(/\s+/).filter((w) => /^[A-Z]/.test(w) && !["Provost", "Mr", "Mrs", "Miss"].includes(w));
    return { id: c.id, voice: casting.voices?.[c.id], names: [...new Set([c.name, ...parts, ...(c.aliases ?? [])])] };
  });
  for (const [id, c] of Object.entries(ep.cast ?? {})) {
    const known = cast.find((x) => x.id === id);
    if (known) { known.voice ??= c.voice; known.names.push(...(c.names ?? [])); }
    else cast.push({ id, voice: c.voice, names: c.names ?? [] });
  }

  const scriptPath = join(engine, pkg.scriptPath ?? join("series", seriesId, "episodes", code, "script.md"));
  const paras = parseScript(readFileSync(scriptPath, "utf8"));
  const quotes = attribute(paras, cast, ep.speakers ?? {});

  const missing = new Set();
  const voiceOf = (id) => {
    const c = cast.find((x) => x.id === id);
    if (c?.voice) return c.voice;
    missing.add(id);
    return id === "narrator" ? cfg.narratorVoice : cfg.fallbackVoices.female;
  };
  const segs = segments(paras, voiceOf, cfg);
  const chars = segs.reduce((n, s) => n + s.text.length, 0);
  const voiceUsd = Math.round((chars / 1e6) * cfg.usdPerMillionChars * 100) / 100;

  const job = {
    model: process.env.KOKORO_MODEL, voices: process.env.KOKORO_VOICES, lang: cfg.lang,
    lexicon: Object.fromEntries(Object.entries(lexicon).filter(([k]) => !k.startsWith("_"))), segments: segs,
  };
  const python = process.env.TTS_PYTHON ?? cfg.python;
  const helper = join(here, "kokoro_tts.py");
  const tmp = mkdtempSync(join(tmpdir(), "narrate-"));
  const jobPath = join(tmp, "job.json");
  const runPy = (...a) => execFileSync(python, [helper, ...a], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: ["ignore", "pipe", "inherit"] });

  try {
    if (flag("--dry-run")) {
      for (const q of quotes) console.log(`#${String(q.n).padStart(3)} ${q.speaker.padEnd(22)} ${voiceOf(q.speaker).padEnd(12)} (${q.why}) ${q.text.slice(0, 70)}`);
      if (job.model && job.voices) {
        const said = Object.fromEntries([
          ...bible.characters.map((c) => [c.name, c.pronunciation ?? ""]),
          ...(bible.glossary ?? []).filter((g) => g.pronunciation).map((g) => [g.term, g.pronunciation]),
        ]);
        writeFileSync(jobPath, JSON.stringify({ ...job, words: Object.keys(said) }));
        const ipa = JSON.parse(runPy("phonemes", jobPath));
        console.log("\npronunciation (bible respelling -> engine IPA):");
        for (const [w, p] of Object.entries(ipa)) console.log(`  ${w.padEnd(24)} ${said[w].padEnd(22)} ${p}`);
      }
      console.log(`\n${quotes.length} quotes, ${segs.length} segments, ${chars} characters, est. $${voiceUsd}`);
      if (missing.size) console.log(`no voice for: ${[...missing].join(", ")} (set casting/${seriesId}/cast.json voices or casting/${seriesId}/${code}.json cast)`);
      return;
    }
    if (missing.size) { console.error(`no voice for: ${[...missing].join(", ")}. Set casting/${seriesId}/cast.json voices or casting/${seriesId}/${code}.json cast.`); process.exit(1); }
    if (!job.model || !job.voices) { console.error("Set KOKORO_MODEL and KOKORO_VOICES in .env"); process.exit(1); }
    if (voiceUsd > caps.perEpisode.audioOnlyUsd) { console.error(`est. $${voiceUsd} is over the $${caps.perEpisode.audioOnlyUsd} audio cap`); process.exit(1); }

    writeFileSync(jobPath, JSON.stringify(job));
    const wav = join(tmp, "out.wav");
    mkdirSync(outDir, { recursive: true });
    const mp3 = join(outDir, `${code}.mp3`);
    console.log(`${code}: ${segs.length} segments, ${chars} characters. Rendering...`);
    runPy("render", jobPath, wav);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-ac", String(cfg.mp3.channels), "-codec:a", "libmp3lame", "-b:a", cfg.mp3.bitrate,
      "-metadata", `title=${pkg.platformCuts?.title ?? code}`, "-metadata", `album=${bible.title}`,
      "-metadata", "comment=Narrated with an AI voice (Kokoro TTS).", mp3], { stdio: "inherit" });
    const durationSec = Math.round(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], { encoding: "utf8" })));

    const audioPath = relative(repo, mp3).split(sep).join("/");
    writeFileSync(join(outDir, `${code}.json`), JSON.stringify({ durationSec, voiceUsd, engine: cfg.provider }, null, 2) + "\n");
    console.log(JSON.stringify({ episode: code, audioPath, durationSec, voiceUsd, issues: [], pass: true }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
