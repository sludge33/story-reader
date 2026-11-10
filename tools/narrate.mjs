#!/usr/bin/env node
// Narrate an approved story-engine episode to MP3 with Kokoro (local, free) or Gemini TTS (full cast,
// API; see config/tts.json and tools/gemini_tts.mjs).
//
//   node tools/narrate.mjs <seriesId> <code> [--from ../story-engine] [--dry-run] [--force] [--single-voice]
//                          [--engine kokoro|gemini] [--out <variant>] [--yes-paid] [--limit <n>]
//
// --engine gemini: voices from cast.json "gemini" (and <code>.json cast[].gemini); cast.json "respell"
// fixes names in the text sent. Needs GEMINI_API_KEY in .env. Cost is checked against the audio cap,
// and on a paid key (gemini.paidTier) against gemini.maxUsdWithoutAsking unless --yes-paid.
// --limit <n> renders only the first n requests (a trial). --out <variant> writes
// audio/<id>/<code>.<variant>.mp3 (+ .json) instead of <code>.mp3, so trials never replace the episode.
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
import { execFileSync, spawnSync } from "node:child_process";
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

/** "One. Two? Three..." -> ["One.", "Two?", "Three..."] (closing quotes and brackets stay with their sentence). */
export function splitSentences(text) {
  return (text.match(/[^.!?…]+(?:[.!?…]+[)"'’”]*|$)/g) ?? [text]).map((t) => t.trim()).filter(Boolean);
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
  const P = cfg.pauses;
  for (const para of paras) {
    if (para.sceneBreak) { if (segs.length) segs[segs.length - 1].pauseAfter = P.sceneBreak; continue; }
    // A short paragraph ("Tick, tick, tick.") is a dramatic beat: hold the silence before and after it.
    const words = para.parts.reduce((n, p) => n + p.text.split(/\s+/).length, 0);
    const beat = P.beat && words <= (P.beatMaxWords ?? 6);
    if (beat && segs.length) segs[segs.length - 1].pauseAfter = Math.max(segs[segs.length - 1].pauseAfter, P.beat);
    para.parts.forEach((p, i) => {
      const isQuote = p.kind === "quote";
      const voice = isQuote ? voiceOf(p.speaker) : cfg.narratorVoice;
      const speed = isQuote ? cfg.speed.dialogue : cfg.speed.narration;
      const lastPart = i === para.parts.length - 1;
      const sentences = P.sentence ? splitSentences(speakable(p.text)) : [speakable(p.text)];
      sentences.forEach((text, k) => {
        const pause = k < sentences.length - 1 ? P.sentence : !lastPart ? P.segment : beat ? P.beat : P.paragraph;
        push(voice, text, speed, pause);
      });
    });
  }
  return segs;
}

/**
 * Two-pass EBU R128 loudness normalisation (ffmpeg loudnorm) to master = { lufs, truePeak, lra }.
 * Pass 1 measures the render; the returned filter applies a linear gain with true-peak limiting.
 */
export function masterFilter(wav, master) {
  if (!master) return null;
  const target = `I=${master.lufs}:TP=${master.truePeak}:LRA=${master.lra ?? 11}`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", wav, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const m = JSON.parse(r.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/)[0]);
  return `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=24000`;
}

export function loadEnv(root) {
  const p = join(root, ".env");
  if (existsSync(p)) process.loadEnvFile(p);
}

/**
 * Load everything narration needs and build the segment plan. story-engine is only read.
 * Returns { cfg, caps, bible, pkg, cast, quotes, segs, chars, voiceUsd, missing, lexicon, voiceOf, outDir }.
 */
export function buildPlan(repo, engine, seriesId, code, { force = false, singleVoice, provider } = {}) {
  const baseCfg = readJson(join(repo, "config", "tts.json"));
  const prov = provider ?? baseCfg.provider;
  const G = prov === "gemini" ? baseCfg.gemini : null;
  if (prov === "gemini" && !G) throw new Error("config/tts.json has no gemini block");
  // Gemini: the narrator and cast voices come from the gemini blocks; the rest of the plan is shared.
  const cfg = G ? { ...baseCfg, provider: "gemini", narratorVoice: G.narrator.voice } : baseCfg;
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
    throw new Error(`${seriesId} is a ${bible.homePlatform} series; Pocket FM narrates its own. Not narrating.`);
  }
  const approved = ["approved", "published"].includes(pkg.status) || (entry?.lastApproved && code <= entry.lastApproved);
  if (!approved && !force) throw new Error(`${code} is not approved (status ${pkg.status}). Use --force to narrate anyway.`);

  const ep = existsSync(join(castDir, `${code}.json`)) ? readJson(join(castDir, `${code}.json`)) : {};
  const lexicon = Object.fromEntries(Object.entries(casting.lexicon ?? {}).filter(([k]) => !k.startsWith("_")));

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
  const script = readFileSync(scriptPath, "utf8");
  const paras = parseScript(script);
  // Attribution's he/she rule reads gender from the Kokoro voice names, so it runs on the Kokoro cast.
  const quotes = attribute(paras, cast, ep.speakers ?? {});
  const respellMap = Object.fromEntries(Object.entries(casting.respell ?? {}).filter(([k]) => !k.startsWith("_")));
  let styleOf = () => undefined;
  if (G) {
    const gOf = (id) => {
      const g = casting.gemini?.voices?.[id] ?? ep.cast?.[id]?.gemini;
      return typeof g === "string" ? { voice: g } : g;
    };
    for (const c of cast) c.voice = gOf(c.id)?.voice;
    const styles = new Map([[G.narrator.voice, G.narrator.style], ...cast.filter((c) => c.voice).map((c) => [c.voice, gOf(c.id)?.style ?? G.characterStyle])]);
    styleOf = (voice) => styles.get(voice);
  }

  const missing = new Set();
  const voiceOf = (id) => {
    const c = cast.find((x) => x.id === id);
    if (c?.voice) return c.voice;
    missing.add(id);
    return id === "narrator" || G ? cfg.narratorVoice : cfg.fallbackVoices.female;
  };
  // Single-voice mode: the narrator reads every line, dialogue included, at narration speed.
  const single = Boolean(singleVoice ?? cfg.singleVoice);
  const segs = single
    ? segments(paras, () => cfg.narratorVoice, { ...cfg, speed: { ...cfg.speed, dialogue: cfg.speed.narration } })
    : segments(paras, voiceOf, cfg);
  const chars = segs.reduce((n, s) => n + s.text.length, 0);
  const voiceUsd = Math.round((chars / 1e6) * cfg.usdPerMillionChars * 100) / 100;
  return { cfg, caps, bible, pkg, cast, script, paras, quotes, segs, chars, voiceUsd, missing, lexicon, voiceOf, outDir, single, provider: prov, G, styleOf, respellMap };
}

/** Options that take a value ("--from x"): returns { opt(name), args (the positional ones) }. */
export function parseArgs(argv, valued) {
  const skip = new Set(argv.flatMap((a, i) => (valued.includes(a) ? [i + 1] : [])));
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  return { opt, args: argv.filter((a, i) => !a.startsWith("--") && !skip.has(i)) };
}

async function main(argv) {
  const flag = (f) => argv.includes(f);
  const { opt, args } = parseArgs(argv, ["--from", "--engine", "--out", "--limit"]);
  const repo = resolve(here, "..");
  const engine = resolve(repo, opt("--from") ?? "../story-engine");
  const variant = opt("--out");
  const [seriesId, code] = args;
  if (!seriesId || !code) { console.error("usage: node tools/narrate.mjs <seriesId> <code> [--from ../story-engine] [--dry-run] [--force]"); process.exit(2); }
  if (!existsSync(join(engine, "series", "index.json"))) { console.error(`No story-engine found at ${engine}. Pass --from <path>.`); process.exit(2); }
  loadEnv(repo);

  let plan;
  try { plan = buildPlan(repo, engine, seriesId, code, { force: flag("--force"), singleVoice: flag("--single-voice") || undefined, provider: opt("--engine") }); }
  catch (e) { console.error(e.message); process.exit(1); }
  if (plan.provider === "gemini") return narrateGemini(plan, { repo, seriesId, code, variant, dryRun: flag("--dry-run"), yesPaid: flag("--yes-paid"), limit: Number(opt("--limit")) || 0 });
  if (variant) { console.error("--out is only supported with --engine gemini for now"); process.exit(2); }
  const { cfg, caps, bible, pkg, quotes, segs, chars, voiceUsd, missing, lexicon, voiceOf, outDir } = plan;

  const job = {
    model: process.env.KOKORO_MODEL, voices: process.env.KOKORO_VOICES, lang: cfg.lang,
    lexicon, levelMatch: cfg.levelMatch, segments: segs,
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
    const af = masterFilter(wav, cfg.master);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, ...(af ? ["-af", af] : []), "-ac", String(cfg.mp3.channels), "-codec:a", "libmp3lame", "-b:a", cfg.mp3.bitrate,
      "-metadata", `title=${pkg.platformCuts?.title ?? code}`, "-metadata", `album=${bible.title}`,
      "-metadata", "comment=Narrated with an AI voice (Kokoro TTS).", mp3], { stdio: "inherit" });
    const durationSec = Math.round(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], { encoding: "utf8" })));

    const audioPath = relative(repo, mp3).split(sep).join("/");
    writeFileSync(join(outDir, `${code}.json`), JSON.stringify({ durationSec, voiceUsd, engine: cfg.provider, ...(plan.single ? { singleVoice: true } : {}) }, null, 2) + "\n");
    console.log(JSON.stringify({ episode: code, audioPath, durationSec, voiceUsd, issues: [], pass: true }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Master wav (config/tts.json master) and encode to MP3 (mp3 settings). Returns duration in whole seconds. */
export function encodeMp3(wav, mp3, cfg, tags) {
  const af = masterFilter(wav, cfg.master);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, ...(af ? ["-af", af] : []), "-ac", String(cfg.mp3.channels), "-codec:a", "libmp3lame", "-b:a", cfg.mp3.bitrate,
    ...Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]), mp3], { stdio: "inherit" });
  return Math.round(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], { encoding: "utf8" })));
}

async function narrateGemini(plan, { repo, seriesId, code, variant, dryRun, yesPaid, limit }) {
  const { cfg, caps, bible, pkg, quotes, segs, missing, voiceOf, outDir, G } = plan;
  const { planRequests, estimateUsd, renderGemini } = await import("./gemini_tts.mjs");
  const reqs = planRequests(segs, cfg, G, plan.styleOf, plan.respellMap);
  const est = estimateUsd(reqs, G);
  if (dryRun) {
    for (const q of quotes) console.log(`#${String(q.n).padStart(3)} ${q.speaker.padEnd(22)} ${voiceOf(q.speaker).padEnd(10)} (${q.why}) ${q.text.slice(0, 70)}`);
    console.log("\nrequests (voice, chars, gap after):");
    reqs.forEach((r, k) => console.log(`  ${String(k + 1).padStart(3)} ${r.voice.padEnd(9)} ${String(r.text.length).padStart(5)} ${r.gapAfter.toFixed(1)}s  ${r.text.slice(0, 60).replace(/\s+/g, " ")}`));
    console.log(`\nrespell: ${JSON.stringify(plan.respellMap)}`);
    console.log(`${quotes.length} quotes, ${reqs.length} requests (1 speaker each), ${reqs.reduce((n, r) => n + r.text.length, 0)} characters; est. ${est.textTokens} text + ${est.audioTokens} audio tokens = $${est.usd} at paid rates (${G.model})`);
    if (missing.size) console.log(`no Gemini voice for: ${[...missing].join(", ")} (set casting/${seriesId}/cast.json gemini.voices or casting/${seriesId}/${code}.json cast[].gemini)`);
    return;
  }
  if (missing.size) { console.error(`no Gemini voice for: ${[...missing].join(", ")}`); process.exit(1); }
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error("Set GEMINI_API_KEY in .env (create the key in Google AI Studio)."); process.exit(1); }
  if (est.usd > caps.perEpisode.audioOnlyUsd) { console.error(`est. $${est.usd} is over the $${caps.perEpisode.audioOnlyUsd} audio cap`); process.exit(1); }
  if (G.paidTier && !yesPaid && est.usd > G.maxUsdWithoutAsking) { console.error(`est. $${est.usd} on a paid key; rerun with --yes-paid to accept`); process.exit(1); }

  const name = variant ? `${code}.${variant}` : code;
  const mp3 = join(outDir, `${name}.mp3`), sidecar = join(outDir, `${name}.json`);
  if (!variant && existsSync(mp3) && (!existsSync(sidecar) || readJson(sidecar).engine !== "gemini")) {
    console.error(`${relative(repo, mp3)} was not made with Gemini. Use --out <variant> for a separate file, or move it aside first.`); process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "narrate-"));
  try {
    const wav = join(tmp, "out.wav");
    console.error(`${code}: ${reqs.length} requests to ${G.model}${limit ? ` (first ${limit} only)` : ""}...`);
    const t0 = Date.now();
    let stats;
    try { stats = await renderGemini(reqs, { G, key, cacheDir: join(repo, ".cache", "gemini", seriesId), outWav: wav, limit }); }
    catch (e) { console.error(`${e.message}\nClips made so far are cached; rerun the same command to continue.`); process.exit(1); }
    const durationSec = encodeMp3(wav, mp3, cfg, { title: pkg.platformCuts?.title ?? code, album: bible.title, comment: "Narrated with AI voices (Gemini TTS)." });
    const voices = Object.fromEntries([["narrator", cfg.narratorVoice], ...plan.cast.filter((c) => c.voice && segs.some((s) => s.voice === c.voice)).map((c) => [c.id, c.voice])]);
    const side = {
      durationSec, voiceUsd: stats.usd, engine: "gemini", model: G.model, ...(limit ? { partial: `${Math.min(limit, reqs.length)}/${reqs.length} requests` } : {}),
      requests: reqs.length, apiCalls: stats.requests, cachedCalls: stats.cached, textTokens: stats.textTokens, audioTokens: stats.audioTokens,
      tokensFrom: stats.usageReported ? "api usage" : "estimate (25 audio tokens/s, 4 chars per text token)",
      renderWallSec: Math.round((Date.now() - t0) / 1000), apiSec: Math.round(stats.apiMs / 1000), renderedAt: new Date().toISOString().slice(0, 10), voices,
    };
    writeFileSync(sidecar, JSON.stringify(side, null, 2) + "\n");
    console.log(JSON.stringify({ episode: code, audioPath: relative(repo, mp3).split(sep).join("/"), ...side, voices: undefined }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
