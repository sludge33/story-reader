// Gemini TTS backend for tools/narrate.mjs (config/tts.json "gemini").
//
// One speaker per request: every speaker turn is its own request, so two voices can never run
// into each other, and library voices (Fola, Sami...) work (the API only promises prebuilt
// voices in 2-speaker requests). Long narration runs are cut at paragraph ends (maxChars).
// Each clip has its edge silence trimmed and its level matched, then clips are joined with
// set gaps: pauses.turn between speakers, pauses.paragraph when the turn also ends a paragraph,
// pauses.chunk between two requests of the same voice, pauses.sceneBreak at scene breaks.
//
// API: POST https://generativelanguage.googleapis.com/v1beta/interactions (key in GEMINI_API_KEY).
// Clips are cached in .cache/gemini/ by hash of {model, voice, style, text}: a rerun only pays for
// requests whose text, voice or style changed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const API = "https://generativelanguage.googleapis.com/v1beta";
const RATE = 24000; // Gemini returns 24 kHz mono 16-bit PCM.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Apply cast.json "respell" ({ "Quay": "Key" }) to text sent to Gemini. Whole words, case kept for the first letter. */
export function respell(text, map = {}) {
  let out = text;
  for (const [from, to] of Object.entries(map)) {
    if (from.startsWith("_")) continue;
    const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to.toLowerCase()));
  }
  return out;
}

/**
 * Group plan segments into single-speaker requests.
 * segs: [{ voice, text, pauseAfter }] from narrate.mjs segments(); P: cfg.pauses (Kokoro plan pauses, used to
 * recognise paragraph ends and scene breaks); G: cfg.gemini. styleOf(voice) -> style prompt.
 */
export function planRequests(segs, cfg, G, styleOf, respellMap) {
  const P = cfg.pauses, GP = G.pauses;
  const reqs = [];
  let cur = null;
  segs.forEach((s, i) => {
    const prevSeg = segs[i - 1];
    const paraEnd = prevSeg && prevSeg.pauseAfter >= P.paragraph;
    const scene = prevSeg && prevSeg.pauseAfter >= P.sceneBreak;
    const sameVoice = cur && cur.voice === s.voice;
    const tooLong = cur && cur.text.length + s.text.length > G.maxChars && paraEnd;
    if (!cur || !sameVoice || scene || tooLong) {
      if (cur) cur.gapAfter = scene ? GP.sceneBreak : !sameVoice ? (paraEnd ? GP.paragraph : GP.turn) : GP.chunk;
      cur = { voice: s.voice, style: styleOf(s.voice), text: "", segs: [] };
      reqs.push(cur);
    } else {
      cur.text += paraEnd ? "\n\n" : " ";
    }
    cur.text += respell(s.text, respellMap);
    cur.segs.push(i);
  });
  if (cur) cur.gapAfter = 0;
  return reqs;
}

/** Rough cost before rendering: text tokens ~ chars/4, audio at wpm. */
export function estimateUsd(reqs, G) {
  const chars = reqs.reduce((n, r) => n + r.text.length + (r.style?.length ?? 0), 0);
  const words = reqs.reduce((n, r) => n + r.text.split(/\s+/).length, 0);
  const audioTokens = (words / (G.estWpm ?? 160)) * 60 * G.audioTokensPerSec;
  return { textTokens: Math.round(chars / 4), audioTokens: Math.round(audioTokens), usd: usd(chars / 4, audioTokens, G) };
}
const usd = (textTokens, audioTokens, G) => Math.round(((textTokens * G.usdPerMillion.input + audioTokens * G.usdPerMillion.audio) / 1e6) * 1000) / 1000;

/** Library voice names -> ids via GET /voices, cached in .cache/gemini/voices.json. Prebuilt names pass through. */
export async function voiceIds(names, key, cacheDir, G) {
  const path = join(cacheDir, "voices.json");
  const known = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const want = names.filter((n) => !(n in known) && !G.prebuiltVoices.includes(n) && !/^voice(key)?_/.test(n));
  if (want.length) {
    let page = "";
    const all = [];
    for (let k = 0; k < 50; k++) {
      const res = await fetch(`${API}/voices?page_size=1000${page ? `&page_token=${encodeURIComponent(page)}` : ""}`, { headers: { "x-goog-api-key": key } });
      if (!res.ok) throw new Error(`voice list failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      all.push(...(j.voices ?? []));
      page = j.next_page_token ?? j.nextPageToken;
      if (!page) break;
    }
    for (const n of want) {
      const hits = all.filter((v) => [v.display_name, v.displayName, v.name, v.id].some((x) => x && x.toLowerCase() === n.toLowerCase()));
      if (hits.length > 1) console.error(`  voice "${n}": ${hits.length} matches, using ${hits[0].id}`);
      known[n] = hits[0]?.id ?? n; // not found: send the name as given and let the API decide
    }
    writeFileSync(path, JSON.stringify(known, null, 2) + "\n");
  }
  return (n) => known[n] ?? n;
}

/** Seconds to wait from a 429/5xx response: RetryInfo, Retry-After, else exponential. */
function retryWait(res, body, attempt) {
  const info = body?.error?.details?.find((d) => /RetryInfo/.test(d["@type"] ?? ""));
  const s = info?.retryDelay ? parseFloat(info.retryDelay) : Number(res.headers.get("retry-after"));
  return Math.min(Number.isFinite(s) && s > 0 ? s + 1 : 5 * 2 ** attempt, 300);
}

export async function synth(req, voiceId, key, G, log) {
  const content = { type: "text", text: req.text };
  if (req.style) content.annotations = [{ type: "speech_metadata", style: req.style }];
  const body = {
    model: G.model,
    input: [{ type: "user_input", content: [content] }],
    response_format: { type: "audio", mime_type: "audio/wav" },
    generation_config: { speech_config: [{ voice: voiceId }] },
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/interactions`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (res.ok) {
      const audio = (j?.steps ?? []).flatMap((s) => s.content ?? []).filter((c) => c.type === "audio" && c.data).pop();
      if (audio) return { wav: Buffer.from(audio.data, "base64"), usage: j.usage ?? j.usage_metadata ?? j.usageMetadata ?? null };
      if (attempt >= 3) throw new Error(`no audio in response: ${text.slice(0, 400)}`);
      log(`  no audio in response, retrying`);
      continue;
    }
    const daily = /per.?day|PerDay/i.test(text);
    if (res.status === 429 && daily) throw Object.assign(new Error(`daily quota reached (429): ${j?.error?.message ?? text.slice(0, 300)}`), { quota: true });
    if ((res.status === 429 || res.status >= 500) && attempt < G.maxRetries) {
      const s = retryWait(res, j, attempt);
      log(`  ${res.status} ${res.status === 429 ? "rate limited" : "server error"}; waiting ${s.toFixed(0)} s (try ${attempt + 2}/${G.maxRetries + 1})`);
      await sleep(s * 1000);
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${j?.error?.message ?? text.slice(0, 400)}`);
  }
}

/** WAV bytes -> trimmed, level-matched raw s16le 24 kHz mono PCM. */
function cleanClip(wavPath, L) {
  const trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,areverse";
  const vol = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", wavPath, "-af", `${trim},volumedetect`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const mean = Number(vol.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
  const gain = Number.isFinite(mean) ? Math.max(-L.maxGainDb, Math.min(L.maxGainDb, L.rmsDb - mean)) : 0;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", wavPath, "-af", `${trim},volume=${gain.toFixed(2)}dB`, "-ar", String(RATE), "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${wavPath}: ${r.stderr}`);
  return { pcm: r.stdout, gain, mean };
}

function wavHeader(bytes) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  return h;
}

/**
 * Batched mode (gemini.mode "batched"): group the per-turn requests by voice, in story order, into
 * batches of up to G.batchMaxChars. Each batch is one API call with the lines separated by blank
 * lines; tools/split_lines.py cuts the answer back into lines with Whisper word timings. One call
 * per voice keeps each voice consistent and needs ~10 calls an episode instead of ~120.
 */
export function planBatches(reqs, G) {
  const batches = [];
  const open = new Map();
  reqs.forEach((r, i) => {
    let b = open.get(r.voice);
    if (b && b.chars + r.text.length > G.batchMaxChars) b = null;
    if (!b) { b = { voice: r.voice, style: r.style, units: [], chars: 0 }; batches.push(b); open.set(r.voice, b); }
    b.units.push(i);
    b.chars += r.text.length + 2;
  });
  return batches;
}

const flat = (t) => t.replace(/\s+/g, " ").trim();

/** One batched call (cached), then split into lines. Returns [{ i, wavPath, matched, words }]. */
async function renderBatch(b, reqs, { G, key, cacheDir, idOf, log, stats, python, pace }) {
  const lines = b.units.map((i) => flat(reqs[i].text));
  const style = [b.style, G.batchStyle].filter(Boolean).join(". ");
  const hash = createHash("sha256").update(JSON.stringify({ m: G.model, v: b.voice, s: style, t: lines })).digest("hex").slice(0, 24);
  const wavPath = join(cacheDir, `b-${hash}.wav`), metaPath = join(cacheDir, `b-${hash}.json`), cutsPath = join(cacheDir, `b-${hash}.cuts.json`);
  if (existsSync(wavPath) && existsSync(metaPath)) stats.cached++;
  else {
    await pace();
    log(`  ${b.voice.padEnd(9)} ${lines.length} lines, ${b.chars} chars: ${lines[0].slice(0, 50)}`);
    const t0 = Date.now();
    const { wav, usage } = await synth({ text: lines.join("\n\n"), style }, idOf(b.voice), key, G, log);
    const ms = Date.now() - t0;
    writeFileSync(wavPath, wav);
    const sec = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wavPath], { encoding: "utf8" }).stdout);
    writeFileSync(metaPath, JSON.stringify({ voice: b.voice, voiceId: idOf(b.voice), lines: lines.length, chars: b.chars, sec, ms, usage, at: new Date().toISOString() }, null, 2) + "\n");
    stats.requests++;
    stats.apiMs += ms;
    countTokens(stats, usage, sec, lines.join("\n\n").length + style.length, G);
  }
  stats.audioSec += JSON.parse(readFileSync(metaPath, "utf8")).sec;
  if (!existsSync(cutsPath)) {
    const linesPath = join(cacheDir, `b-${hash}.lines.json`);
    writeFileSync(linesPath, JSON.stringify(lines));
    const helper = join(dirname(fileURLToPath(import.meta.url)), "split_lines.py");
    const r = spawnSync(python, [helper, wavPath, linesPath, cutsPath], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    if (r.status !== 0) throw new Error(`split_lines failed for ${b.voice}: ${r.stderr.slice(-800)}`);
  }
  const { cuts, score } = JSON.parse(readFileSync(cutsPath, "utf8"));
  if (cuts.length !== lines.length) throw new Error(`split_lines gave ${cuts.length} pieces for ${lines.length} lines (${b.voice})`);
  stats.batches.push({ voice: b.voice, lines: lines.length, chars: b.chars, score });
  return cuts.map((c, k) => {
    const piece = join(cacheDir, `b-${hash}.${k}.wav`);
    if (!existsSync(piece)) {
      const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, "-ss", String(c.start), "-to", String(c.end), "-c", "copy", piece]);
      if (r.status !== 0) throw new Error(`ffmpeg cut failed: ${r.stderr}`);
    }
    if (c.words >= 3 && c.matched / c.words < 0.6) stats.weakLines.push({ voice: b.voice, text: lines[k], matched: c.matched, words: c.words });
    return { i: b.units[k], wavPath: piece };
  });
}

function countTokens(stats, usage, sec, chars, G) {
  // Tokens: from the response when it reports them, else 25 audio tokens/s and ~4 chars per text token.
  const u = usage ?? {};
  const out = u.output_tokens ?? u.total_output_tokens ?? u.candidatesTokenCount ?? u.output_audio_tokens;
  const inp = u.input_tokens ?? u.total_input_tokens ?? u.promptTokenCount;
  if (out != null) stats.usageReported = true;
  stats.audioTokens += out ?? Math.round(sec * G.audioTokensPerSec);
  stats.textTokens += inp ?? Math.round(chars / 4);
}

/**
 * Render requests to one WAV at outWav. Returns stats for the sidecar and the report.
 * Requests run one at a time, spaced to G.rpm; cached clips cost nothing.
 * G.mode "batched": one call per voice batch (planBatches), else one call per request.
 */
export async function renderGemini(reqs, { G, key, cacheDir, outWav, log = console.error, limit, python = "python" }) {
  mkdirSync(cacheDir, { recursive: true });
  const idOf = await voiceIds([...new Set(reqs.map((r) => r.voice))], key, cacheDir, G);
  if (G.mode === "batched") {
    const started = Date.now();
    const stats = { mode: "batched", requests: 0, cached: 0, textTokens: 0, audioTokens: 0, audioSec: 0, usageReported: false, apiMs: 0, batches: [], weakLines: [] };
    let lastCall = 0;
    const pace = async () => { const w = G.rpm ? lastCall + 60000 / G.rpm - Date.now() : 0; if (w > 0) await sleep(w); lastCall = Date.now(); };
    const batches = planBatches(reqs, G);
    const todo = limit ? batches.slice(0, limit) : batches;
    const pieces = new Map();
    for (const b of todo) for (const p of await renderBatch(b, reqs, { G, key, cacheDir, idOf, log, stats, python, pace })) pieces.set(p.i, p.wavPath);
    const parts = [];
    reqs.forEach((req, i) => {
      if (!pieces.has(i)) return;
      parts.push(cleanClip(pieces.get(i), G.levelMatch).pcm);
      if (req.gapAfter) parts.push(Buffer.alloc(Math.round(req.gapAfter * RATE) * 2));
    });
    const data = Buffer.concat(parts);
    writeFileSync(outWav, Buffer.concat([wavHeader(data.length), data]));
    stats.wallSec = Math.round((Date.now() - started) / 1000);
    stats.usd = usd(stats.textTokens, stats.audioTokens, G);
    return stats;
  }
  const started = Date.now();
  const stats = { requests: 0, cached: 0, textTokens: 0, audioTokens: 0, audioSec: 0, usageReported: false, apiMs: 0 };
  const parts = [];
  let lastCall = 0;
  const todo = limit ? reqs.slice(0, limit) : reqs;
  for (const [k, req] of todo.entries()) {
    const hash = createHash("sha256").update(JSON.stringify({ m: G.model, v: req.voice, s: req.style ?? "", t: req.text })).digest("hex").slice(0, 24);
    const wavPath = join(cacheDir, `${hash}.wav`), metaPath = join(cacheDir, `${hash}.json`);
    let meta;
    if (existsSync(wavPath) && existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
      stats.cached++;
    } else {
      const wait = G.rpm ? lastCall + 60000 / G.rpm - Date.now() : 0;
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      log(`  ${String(k + 1).padStart(3)}/${todo.length} ${req.voice.padEnd(9)} ${req.text.length} chars: ${req.text.slice(0, 50).replace(/\s+/g, " ")}`);
      const t0 = Date.now();
      const { wav, usage } = await synth(req, idOf(req.voice), key, G, log);
      const ms = Date.now() - t0;
      writeFileSync(wavPath, wav);
      const sec = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wavPath], { encoding: "utf8" }).stdout);
      meta = { voice: req.voice, voiceId: idOf(req.voice), chars: req.text.length, sec, ms, usage, at: new Date().toISOString() };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      stats.requests++;
      stats.apiMs += ms;
      // Tokens: from the response when it reports them, else 25 audio tokens/s and ~4 chars per text token.
      const u = usage ?? {};
      const out = u.output_tokens ?? u.total_output_tokens ?? u.candidatesTokenCount ?? u.output_audio_tokens;
      const inp = u.input_tokens ?? u.total_input_tokens ?? u.promptTokenCount;
      if (out != null) stats.usageReported = true;
      stats.audioTokens += out ?? Math.round(sec * G.audioTokensPerSec);
      stats.textTokens += inp ?? Math.round((req.text.length + (req.style?.length ?? 0)) / 4);
    }
    stats.audioSec += meta.sec;
    const { pcm } = cleanClip(wavPath, G.levelMatch);
    parts.push(pcm);
    if (req.gapAfter) parts.push(Buffer.alloc(Math.round(req.gapAfter * RATE) * 2));
  }
  const data = Buffer.concat(parts);
  writeFileSync(outWav, Buffer.concat([wavHeader(data.length), data]));
  stats.wallSec = Math.round((Date.now() - started) / 1000);
  stats.usd = usd(stats.textTokens, stats.audioTokens, G);
  return stats;
}
