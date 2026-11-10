#!/usr/bin/env node
// Quality check a narrated episode: script lint, signal (loudness, peaks, clipping, gaps), and a Whisper
// listen-back aligned to the script (mispronounced names, garbled or skipped words, pace, per-voice level).
//
//   node tools/qc.mjs <seriesId> <code> [--from ../story-engine] [--no-asr] [--out <variant>]
//
// Reads audio/<id>/<code>.mp3 and the same segment plan tools/narrate.mjs used (engine from the audio's
// .json sidecar). Gates live in config/qc.json. --out <variant> checks audio/<id>/<code>.<variant>.mp3.
// Writes qc/<id>/<name>.md (for listening) and qc/<id>/<name>.json. Exits 1 if a gate fails.
// story-engine is READ-ONLY here. The Whisper transcript is cached in .cache/ (gitignored).

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlan, loadEnv, parseArgs } from "./narrate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Things in the narrated text the engine is likely to read badly. */
export function lintText(segs, knownWords) {
  const known = new Set([...knownWords].map((w) => w.toLowerCase()));
  const rules = [
    [/\d/, "digits (spell out, or check how they're read)"],
    [/\b(Mr|Mrs|Ms|Dr|St|No|Mt)\./, "abbreviation"],
    [/[*_#`[\]{}<>]/, "markdown or markup symbol"],
    [/[&%@+=]/, "symbol read aloud"],
    [/["“”]/, "unpaired quote mark (quote may be read by the wrong voice)"],
    [/\(.*?\)/, "parenthetical (no pause or tone change)"],
  ];
  const issues = [];
  segs.forEach((s, i) => {
    for (const [re, why] of rules) if (re.test(s.text)) issues.push({ seg: i, why, text: s.text.slice(0, 120) });
  });
  // Mid-sentence capitalised words the lexicon and bible don't cover: likely names to check by ear.
  const unknown = new Map();
  for (const s of segs) {
    for (const m of s.text.matchAll(/(?<=[a-z;]\s)(?!I[’'])([A-Z][a-z’']+)/g)) {
      const w = m[1].replace(/[’']s$/, "");
      if (!known.has(w.toLowerCase())) unknown.set(w, (unknown.get(w) ?? 0) + 1);
    }
  }
  return { issues, unknownNames: [...unknown].sort((a, b) => b[1] - a[1]) };
}

function signal(mp3, gates) {
  const ebur = ffErr(mp3, "ebur128=peak=true+sample");
  const num = (re, s) => { const m = s.match(re); return m ? Number(m[1]) : null; };
  const summary = ebur.slice(ebur.lastIndexOf("Summary:"));
  const lufs = num(/I:\s+(-?[\d.]+) LUFS/, summary);
  const lra = num(/LRA:\s+(-?[\d.]+) LU/, summary);
  const truePeak = num(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/, summary);
  const samplePeak = num(/Sample peak:\s+Peak:\s+(-?[\d.]+) dBFS/, summary);
  // Clipped samples: |x| at or above -0.1 dBFS.
  const astats = ffErr(mp3, "astats=metadata=0:measure_overall=Peak_level+Peak_count:measure_perchannel=none");
  const peakLevel = num(/Peak level dB:\s+(-?[\d.]+)/, astats);
  const peakCount = num(/Peak count:\s+(\d+)/, astats);
  const clipped = peakLevel != null && peakLevel >= -0.1 ? peakCount : 0;
  const sil = ffErr(mp3, `silencedetect=n=-45dB:d=${gates.maxGapSec}`);
  const gaps = [...sil.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => ({ at: Number(m[1]) - Number(m[2]), sec: Number(m[2]) }));
  return { lufs, lra, truePeak, samplePeak, clipped, gaps };
}

/** Run an ffmpeg audio filter over the file and return its log (ffmpeg reports on stderr). */
function ffErr(mp3, af) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", mp3, "-af", af, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return r.stderr ?? "";
}

function main(argv) {
  const { opt, args } = parseArgs(argv, ["--from", "--out"]);
  const engine = resolve(repo, opt("--from") ?? "../story-engine");
  const [seriesId, code] = args;
  const name = opt("--out") ? `${code}.${opt("--out")}` : code;
  if (!seriesId || !code) { console.error("usage: node tools/qc.mjs <seriesId> <code> [--from ../story-engine] [--no-asr]"); process.exit(2); }
  loadEnv(repo);
  const gates = readJson(join(repo, "config", "qc.json"));
  // Check against the plan the audio was made with (its sidecar records single-voice renders).
  const sidecar = join(repo, "audio", seriesId, `${name}.json`);
  const side = existsSync(sidecar) ? readJson(sidecar) : {};
  const plan = buildPlan(repo, engine, seriesId, code, { force: true, singleVoice: Boolean(side.singleVoice), provider: side.engine === "gemini" ? "gemini" : undefined });
  const mp3 = join(repo, "audio", seriesId, `${name}.mp3`);
  if (!existsSync(mp3)) { console.error(`No audio at ${mp3}. Run tools/narrate.mjs first.`); process.exit(1); }

  const whoOf = new Map([[plan.cfg.narratorVoice, "narrator"], ...plan.cast.filter((c) => c.voice).map((c) => [c.voice, c.id.replace(/^c-/, "")])]);
  const segs = plan.segs.map((s, i) => ({ i, voice: s.voice, who: whoOf.get(s.voice) ?? s.voice, text: s.text }));
  const names = [...new Set([
    ...Object.keys(plan.lexicon),
    ...plan.cast.flatMap((c) => c.names.flatMap((n) => n.split(/\s+/))),
    ...(plan.bible.glossary ?? []).flatMap((g) => g.term.split(/\s+/)),
  ])].filter((w) => /^[A-Z]/.test(w));

  // Bible respellings ("KEY") as the words a listener should hear, per name word.
  const sayAs = {};
  for (const e of [...plan.bible.characters.map((c) => [c.name, c.pronunciation]), ...(plan.bible.glossary ?? []).map((g) => [g.term, g.pronunciation])]) {
    const [name, resp] = e;
    if (!resp) continue;
    const nw = name.split(/\s+/).filter((w) => !/^(Provost|Mr|Mrs|Miss|Street)$/.test(w)), rw = resp.split(/\s+/);
    if (nw.length === rw.length) nw.forEach((w, k) => (sayAs[w] ??= []).push(rw[k].replace(/-/g, "")));
  }

  const lint = lintText(plan.segs, [...names, ...plan.cast.flatMap((c) => c.names)]);
  console.error(`${code}: measuring signal...`);
  const sig = signal(mp3, gates);

  let asr = null;
  if (!argv.includes("--no-asr")) {
    console.error(`${code}: Whisper listen-back (${gates.asr.model}); first run takes a few minutes...`);
    const tmp = mkdtempSync(join(tmpdir(), "qc-"));
    try {
      const exp = join(tmp, "expected.json"), out = join(tmp, "asr.json");
      writeFileSync(exp, JSON.stringify({ segments: segs, names, sayAs }));
      const cache = join(repo, ".cache", "qc", seriesId, `${name}.asr.json`);
      const python = process.env.TTS_PYTHON ?? plan.cfg.python;
      execFileSync(python, [join(here, "asr_qc.py"), mp3, exp, out, "--model", gates.asr.model, "--cache", cache],
        { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      asr = readJson(out);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // Per-voice pace and level from the aligned segments.
  const voices = {};
  for (const s of asr?.segments ?? []) {
    const v = (voices[s.who] ??= { voice: s.voice, secs: 0, words: 0, rms: [] });
    if (s.wpm) { v.secs += s.end - s.start; v.words += (s.wpm * (s.end - s.start)) / 60; }
    if (s.rmsDb != null && s.end - s.start > 1.5) v.rms.push(s.rmsDb);
  }
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
  const voiceRows = Object.entries(voices).map(([who, v]) => ({ who, voice: v.voice, wpm: v.secs ? Math.round((v.words / v.secs) * 60) : null, levelDb: median(v.rms) }));
  const levels = voiceRows.map((r) => r.levelDb).filter((x) => x != null);
  const spread = levels.length ? Math.round((Math.max(...levels) - Math.min(...levels)) * 10) / 10 : 0;

  const L = gates.loudness;
  const checks = [
    { name: "Loudness", pass: Math.abs(sig.lufs - L.targetLufs) <= L.toleranceLu, value: `${sig.lufs} LUFS`, want: `${L.targetLufs} ±${L.toleranceLu}` },
    { name: "True peak", pass: sig.truePeak <= L.maxTruePeakDbtp, value: `${sig.truePeak} dBTP`, want: `≤ ${L.maxTruePeakDbtp}` },
    { name: "Clipping", pass: sig.clipped <= gates.maxClippedSamples, value: `${sig.clipped} samples at full scale`, want: `${gates.maxClippedSamples}` },
    { name: "Dead air", pass: sig.gaps.length === 0, value: sig.gaps.length ? sig.gaps.map((g) => `${mmss(g.at)} (${g.sec.toFixed(1)}s)`).join(", ") : "none", want: `no silence > ${gates.maxGapSec}s` },
    { name: "Script lint", pass: lint.issues.length === 0, value: `${lint.issues.length} issue(s)`, want: "0" },
  ];
  if (asr) {
    const real = asr.issues.filter((x) => ["misheard", "missing", "extra"].includes(x.kind));
    checks.push({ name: "Word accuracy", pass: asr.wer <= gates.asr.maxWer, value: `${((1 - asr.wer) * 100).toFixed(1)}% (${real.length} spots)`, want: `≥ ${((1 - gates.asr.maxWer) * 100).toFixed(0)}%` });
    const durationSec = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], { encoding: "utf8" }));
    const wpm = Math.round(asr.words / durationSec * 60);
    checks.push({ name: "Pace (overall)", pass: wpm >= gates.pace.minWpm && wpm <= gates.pace.maxWpm, value: `${wpm} wpm`, want: `${gates.pace.minWpm}-${gates.pace.maxWpm} wpm` });
    checks.push({ name: "Voice level match", pass: spread <= gates.voiceLevelSpreadDb, value: `${spread} dB spread`, want: `≤ ${gates.voiceLevelSpreadDb} dB` });
  }
  const pass = checks.every((c) => c.pass);

  // Report.
  const md = [];
  const made = side.engine === "gemini" ? ` Engine: ${side.model ?? "Gemini"}, ${side.requests} single-speaker requests.` : "";
  md.push(`# QC: ${plan.bible.title} ${name}`, "", `${pass ? "**PASS**" : "**FAIL**"}. Audio \`audio/${seriesId}/${name}.mp3\`, checked against the narration plan (${plan.segs.length} segments).${made}`, "");
  md.push("| Check | Result | Target | |", "|---|---|---|---|");
  for (const c of checks) md.push(`| ${c.name} | ${c.value} | ${c.want} | ${c.pass ? "ok" : "**fail**"} |`);
  if (asr) {
    md.push("", "## Voices", "", "Pace here is while speaking (pauses excluded), so it runs higher than the overall figure.", "", "| Who | Voice | Speaking rate (wpm) | Level (median dB RMS) |", "|---|---|---|---|");
    for (const r of voiceRows) md.push(`| ${r.who} | ${r.voice} | ${r.wpm ?? "-"} | ${r.levelDb ?? "-"} |`);
    md.push("", "## Names: what Whisper heard", "", "A name that comes back as other words was probably said wrong. Listen, then fix it in `casting/<series>/cast.json` `lexicon`.", "");
    md.push("| Name | Heard as |", "|---|---|");
    for (const [n, got] of Object.entries(asr.names)) md.push(`| ${n} | ${Object.entries(got).map(([g, k]) => `${g === n ? "✓" : `"${g}"`} ×${k}`).join(", ")} |`);
    const spots = asr.issues.filter((x) => ["misheard", "missing", "extra"].includes(x.kind));
    md.push("", "## Listen to these", "", "Places the transcript doesn't match the script. Some are Whisper's mistakes; listen before fixing.", "");
    md.push("| Time | Who | Script | Heard | Kind |", "|---|---|---|---|---|");
    for (const x of spots) md.push(`| ${mmss(x.time)} | ${x.who} | ${x.context.replace(/\|/g, "/")} | ${x.heard || "(nothing)"} | ${x.kind}${x.name ? ", name" : ""} |`);
    const unclear = asr.issues.filter((x) => x.kind === "unclear");
    if (unclear.length) md.push("", `Low-confidence words (said, but unclear): ${unclear.map((x) => `${mmss(x.time)} "${x.expected}"`).join(", ")}.`);
  }
  md.push("", "## Script lint", "");
  if (lint.issues.length) for (const x of lint.issues) md.push(`- seg ${x.seg}: ${x.why}: "${x.text}"`);
  else md.push("- No issues.");
  if (lint.unknownNames.length) md.push(`- Capitalised words not in the lexicon or bible (check by ear): ${lint.unknownNames.map(([w, n]) => `${w} ×${n}`).join(", ")}.`);
  md.push("", "## How to fix", "", "- Name said wrong: add or correct it in `casting/<series>/cast.json` `lexicon` (`/IPA/` or a respelling), check with `narrate.mjs --dry-run`, re-render.", "- Wrong voice on a line: `casting/<series>/<code>.json` `speakers`.", "- Loudness, peaks, clipping: fixed in the render step (`config/tts.json` `master`); re-render.", "- Pace: `config/tts.json` `speed`.", "");

  const outDir = join(repo, "qc", seriesId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.md`), md.join("\n"));
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ code, pass, checks, signal: sig, voices: voiceRows, lint, asr: asr && { wer: asr.wer, model: asr.model, names: asr.names, issues: asr.issues } }, null, 2) + "\n");
  console.log(JSON.stringify({ episode: code, pass, failed: checks.filter((c) => !c.pass).map((c) => c.name), report: `qc/${seriesId}/${name}.md` }));
  if (!pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
