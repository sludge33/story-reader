// Story Reader: a static listening site. Hash routes:
//   #/                 library
//   #/s/<series>       series page
//   #/s/<series>/<ep>  episode (read along + player)
//
// Episodes with an MP3 play it. Episodes without one are narrated by the browser's
// speech engine, sentence by sentence, with the current paragraph highlighted.

const view = document.getElementById("view");
const bar = document.getElementById("player");
const tts = "speechSynthesis" in window ? window.speechSynthesis : null;
const CHARS_PER_SEC = 14.5; // ~150 wpm at rate 1, used for estimates only

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 6.2v11.6a.8.8 0 0 1-1.2.7L10 12.7a.8.8 0 0 1 0-1.4l8.8-5.8a.8.8 0 0 1 1.2.7z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 6.2v11.6a.8.8 0 0 0 1.2.7l8.8-5.8a.8.8 0 0 0 0-1.4L5.2 5.5A.8.8 0 0 0 4 6.2z"/></svg>',
};

// ---------- small helpers ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("sr:" + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("sr:" + key, JSON.stringify(value));
    } catch {
      /* private mode or storage blocked: progress just isn't remembered */
    }
  },
};
const fmt = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
};
const mins = (sec) => Math.max(1, Math.round(sec / 60)) + " min";
const epNum = (code) => {
  const m = /^S(\d+)E(\d+)$/.exec(code);
  return m ? `S${+m[1]} · E${+m[2]}` : code;
};
const progressKey = (sid, code) => `p:${sid}/${code}`;
const getProgress = (sid, code) => store.get(progressKey(sid, code), null);

// ---------- data ----------
let catalog = null;
const episodes = new Map();

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
async function loadCatalog() {
  catalog ??= await getJson("content/catalog.json");
  return catalog;
}
async function loadEpisode(sid, code) {
  const key = sid + "/" + code;
  if (!episodes.has(key)) {
    const ep = await getJson(`content/${encodeURIComponent(sid)}/${encodeURIComponent(code)}.json`);
    prepare(ep);
    episodes.set(key, ep);
  }
  return episodes.get(key);
}

// Split paragraphs into speakable chunks and record character offsets for seeking.
function chunk(text) {
  const parts = text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g);
  const squash = (s) => s.replace(/\s+/g, "");
  if (!parts || squash(parts.join("")) !== squash(text)) return [text];
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + p).length > 220) {
      out.push(cur.trim());
      cur = p;
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function prepare(ep) {
  let offset = 0;
  for (const b of ep.blocks) {
    b.start = offset;
    if (b.type === "break") {
      offset += 40; // a scene break is a short pause
    } else {
      b.units = chunk(b.text);
      offset += b.text.length;
    }
  }
  ep.totalChars = offset || 1;
  // Audio versions: the "audio" field is the default; "audioVersions" can add others (e.g. a sample
  // from another voice engine). A version with "endsAtBlock" only covers the text up to that block.
  const list = ep.audioVersions?.length ? ep.audioVersions : ep.audio ? [{ src: ep.audio }] : [];
  ep.versions = list.map((v, i) => {
    const last = v.endsAtBlock != null ? ep.blocks[Math.min(v.endsAtBlock, ep.blocks.length - 1)] : null;
    return {
      ...v,
      id: v.id ?? (i ? "v" + i : "default"),
      label: v.label ?? "Narration",
      durationSec: v.durationSec ?? ep.durationSec,
      spanChars: last ? last.start + (last.text?.length ?? 40) : ep.totalChars,
      sample: v.endsAtBlock != null,
    };
  });
  // The default is the version that matches "audio" (else the first).
  const def = ep.versions.findIndex((v) => v.src === ep.audio);
  if (def > 0) ep.versions.unshift(...ep.versions.splice(def, 1));
}
const versionKey = (ep) => `ver:${ep.seriesId}/${ep.code}`;

function findSeries(sid) {
  return catalog?.series.find((s) => s.id === sid) ?? null;
}
function nextEpisode(sid, code) {
  const s = findSeries(sid);
  if (!s) return null;
  const i = s.episodes.findIndex((e) => e.code === code);
  return i >= 0 ? s.episodes[i + 1] ?? null : null;
}

// ---------- player ----------
const player = {
  ep: null,
  mode: null, // "audio" | "tts"
  playing: false,
  block: 0,
  sentence: 0,
  gen: 0,
  timer: null,
  audio: null,
  version: null, // entry of ep.versions playing in audio mode
  wakeLock: null,
  rate: store.get("rate", 1),
  voiceURI: store.get("voice", null),
};
let lastUserScroll = 0;
["wheel", "touchmove", "keydown"].forEach((t) =>
  window.addEventListener(t, (e) => {
    if (t !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key))
      lastUserScroll = Date.now();
  }, { passive: true }),
);

function englishVoices() {
  if (!tts) return [];
  return tts.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
}
function rankVoice(v) {
  let score = 0;
  if (/natural|neural|online|premium|enhanced/i.test(v.name)) score += 4;
  if (/google/i.test(v.name)) score += 2;
  if (/daniel|serena|arthur|kate|libby|sonia|ryan/i.test(v.name)) score += 2;
  if (/en[-_]GB/i.test(v.lang)) score += 1;
  return score;
}
function currentVoice() {
  const voices = englishVoices();
  if (!voices.length) return null;
  return (
    voices.find((v) => v.voiceURI === player.voiceURI) ??
    voices.slice().sort((a, b) => rankVoice(b) - rankVoice(a))[0]
  );
}
tts?.addEventListener?.("voiceschanged", () => renderVoiceSelect());

function fraction() {
  const ep = player.ep;
  if (!ep) return 0;
  if (player.mode === "audio") return audioFraction() * (player.version.spanChars / ep.totalChars);
  const b = ep.blocks[player.block];
  if (!b) return 1;
  const within = b.units ? b.units.slice(0, player.sentence).join(" ").length : 0;
  return Math.min(1, (b.start + within) / ep.totalChars);
}
// Position in the current audio file (0-1), as opposed to fraction(), the share of the episode text.
function audioFraction() {
  const a = player.audio;
  return a && a.duration ? a.currentTime / a.duration : 0;
}
function blockAtFraction(f) {
  const ep = player.ep;
  const target = f * ep.totalChars;
  let idx = 0;
  ep.blocks.forEach((b, i) => {
    if (b.start <= target) idx = i;
  });
  return idx;
}

function save(done = false) {
  const ep = player.ep;
  if (!ep) return;
  store.set(progressKey(ep.seriesId, ep.code), {
    block: done ? 0 : player.block,
    sentence: done ? 0 : player.sentence,
    time: done ? 0 : player.audio?.currentTime ?? 0,
    frac: done ? 1 : fraction(),
    ver: player.version?.id,
    done: done || !!getProgress(ep.seriesId, ep.code)?.done,
    at: Date.now(),
  });
}

async function loadIntoPlayer(ep) {
  if (player.ep === ep) return;
  stop();
  player.ep = ep;
  player.mode = ep.versions.length ? "audio" : "tts";
  const saved = getProgress(ep.seriesId, ep.code);
  player.block = saved && !(saved.frac >= 1) ? Math.min(saved.block ?? 0, ep.blocks.length - 1) : 0;
  player.sentence = saved && !(saved.frac >= 1) ? saved.sentence ?? 0 : 0;
  player.version = null;
  dropAudio();
  if (player.mode === "audio") {
    const v = ep.versions.find((x) => x.id === store.get(versionKey(ep), null)) ?? ep.versions[0];
    const resume = saved?.time && !(saved.frac >= 1) && (saved.ver ?? ep.versions[0].id) === v.id ? saved.time : 0;
    attachAudio(v, resume);
  }
  renderBar();
  highlight(false);
}

function dropAudio() {
  if (!player.audio) return;
  player.audio.pause();
  player.audio.removeAttribute("src");
  player.audio.load();
  player.audio = null;
}
function attachAudio(v, startAt) {
  const a = new Audio(v.src);
  a.preload = "metadata";
  a.playbackRate = player.rate;
  a.addEventListener("timeupdate", () => a === player.audio && onAudioTime());
  a.addEventListener("ended", () => a === player.audio && (v.sample ? endSample() : finish()));
  a.addEventListener("play", () => a === player.audio && setPlaying(true));
  a.addEventListener("pause", () => a === player.audio && setPlaying(false));
  a.addEventListener("loadedmetadata", () => {
    if (startAt) a.currentTime = Math.min(startAt, a.duration - 1);
    updateBar();
  }, { once: true });
  player.version = v;
  player.audio = a;
}

// Switch to another audio version at the same paragraph, if the new one covers it.
function setVersion(id) {
  const ep = player.ep;
  const v = ep?.versions.find((x) => x.id === id);
  if (!v || v === player.version) return;
  const wasPlaying = player.playing;
  const blockStart = ep.blocks[player.block]?.start ?? 0;
  const atStart = player.audio?.currentTime < 1;
  stop();
  dropAudio();
  store.set(versionKey(ep), v.id);
  const at = !atStart && blockStart < v.spanChars ? (blockStart / v.spanChars) * v.durationSec : 0;
  if (!at) player.block = 0;
  attachAudio(v, at);
  renderBar();
  highlight(true, true);
  save();
  if (wasPlaying) play();
}

// A sample ends before the episode does: stop and rewind, without marking the episode played.
function endSample() {
  stop();
  player.block = 0;
  player.audio.currentTime = 0;
  save();
  updateBar();
  highlight(false);
}

let lastAudioSave = 0;
function onAudioTime() {
  const b = blockAtFraction(fraction());
  if (b !== player.block) {
    player.block = b;
    highlight(true);
  }
  if (Date.now() - lastAudioSave > 5000) {
    lastAudioSave = Date.now();
    save();
  }
  updateBar();
}

function setPlaying(on) {
  player.playing = on;
  const btn = bar.querySelector("[data-act=toggle]");
  if (btn) {
    btn.innerHTML = on ? ICONS.pause : ICONS.play;
    btn.setAttribute("aria-label", on ? "Pause" : "Play");
  }
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
  document.querySelectorAll("[data-act=start]").forEach((b) => {
    if (b.dataset.ep === epKey(player.ep)) b.innerHTML = (on ? ICONS.pause + " Pause" : ICONS.play + " " + startLabel(player.ep));
  });
  keepAwake(on && player.mode === "tts");
}

async function keepAwake(on) {
  // Phones stop speech synthesis when the screen sleeps; hold the screen while narrating.
  try {
    if (on && !player.wakeLock && navigator.wakeLock) player.wakeLock = await navigator.wakeLock.request("screen");
    if (!on && player.wakeLock) {
      await player.wakeLock.release();
      player.wakeLock = null;
    }
  } catch {
    player.wakeLock = null;
  }
}

function play() {
  if (!player.ep) return;
  if (player.mode === "audio") {
    player.audio.play().catch(() => setPlaying(false));
    return;
  }
  if (!tts) return;
  setPlaying(true);
  tts.cancel();
  const gen = ++player.gen;
  setTimeout(() => gen === player.gen && speak(), 60); // Chrome drops speak() issued right after cancel()
}
function stop() {
  player.gen++;
  clearTimeout(player.timer);
  if (player.mode === "tts") tts?.cancel();
  if (player.mode === "audio") player.audio?.pause();
  if (player.playing) setPlaying(false);
}
function pause() {
  stop();
  save();
}
function toggle() {
  player.playing ? pause() : play();
}

function speak() {
  const ep = player.ep;
  const gen = ++player.gen;
  const b = ep.blocks[player.block];
  if (!b) return finish();
  highlight(true);
  updateBar();
  if (b.type === "break") {
    player.timer = setTimeout(() => {
      if (gen !== player.gen) return;
      player.block++;
      player.sentence = 0;
      speak();
    }, 900);
    return;
  }
  if (player.sentence >= b.units.length) {
    player.block++;
    player.sentence = 0;
    save();
    return speak();
  }
  const u = new SpeechSynthesisUtterance(b.units[player.sentence]);
  const voice = currentVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = player.rate;
  const advance = () => {
    if (gen !== player.gen) return;
    player.sentence++;
    speak();
  };
  u.onend = advance;
  u.onerror = (e) => {
    if (e.error === "interrupted" || e.error === "canceled") return;
    advance();
  };
  tts.speak(u);
}

function finish() {
  const ep = player.ep;
  save(true);
  stop();
  player.block = 0;
  player.sentence = 0;
  if (player.audio) player.audio.currentTime = 0;
  updateBar();
  highlight(false);
  const end = document.querySelector(`.end-card[data-ep="${CSS.escape(epKey(ep))}"]`);
  end?.removeAttribute("hidden");
  if (end && Date.now() - lastUserScroll > 4000) end.scrollIntoView({ behavior: "smooth", block: "center" });
}

function seekBlock(i, sentence = 0) {
  const ep = player.ep;
  if (!ep) return;
  i = Math.max(0, Math.min(ep.blocks.length - 1, i));
  player.block = i;
  player.sentence = sentence;
  if (player.mode === "audio") {
    const a = player.audio, start = ep.blocks[i].start;
    if (start >= player.version.spanChars) return; // past the end of a sample
    if (a.duration) a.currentTime = (start / player.version.spanChars) * a.duration;
  } else if (player.playing) play();
  highlight(true, true);
  updateBar();
  save();
}
function step(dir) {
  const ep = player.ep;
  if (!ep) return;
  if (player.mode === "audio") {
    const a = player.audio;
    a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + (dir < 0 ? -15 : 30)));
    return;
  }
  let i = player.block;
  if (dir < 0 && player.sentence > 0) return seekBlock(i);
  do i += dir;
  while (ep.blocks[i]?.type === "break");
  if (i >= ep.blocks.length) return finish();
  seekBlock(i);
}
function setRate(r) {
  player.rate = r;
  store.set("rate", r);
  if (player.audio) player.audio.playbackRate = r;
  else if (player.playing) play();
  updateBar();
}

function epKey(ep) {
  return ep ? ep.seriesId + "/" + ep.code : "";
}
function startLabel(ep) {
  const p = getProgress(ep.seriesId, ep.code);
  return p && !p.done && p.frac > 0.01 && p.frac < 1 ? "Resume" : p?.done ? "Listen again" : "Listen";
}

function highlight(follow, force = false) {
  const ep = player.ep;
  document.querySelectorAll(".script p.current").forEach((p) => p.classList.remove("current"));
  const script = document.querySelector(`.script[data-ep="${CSS.escape(epKey(ep))}"]`);
  if (!script) return;
  const el = script.querySelector(`[data-block="${player.block}"]`);
  if (!el || (!player.playing && !force && player.block === 0)) return;
  el.classList.add("current");
  if (!follow) return;
  if (!force && Date.now() - lastUserScroll < 4000) return;
  const r = el.getBoundingClientRect();
  const bottom = window.innerHeight - bar.offsetHeight;
  if (force || r.top < 60 || r.bottom > bottom - 20)
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
}

function renderBar() {
  const ep = player.ep;
  if (!ep) {
    bar.hidden = true;
    document.documentElement.style.setProperty("--player-h", "0px");
    return;
  }
  const speeds = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75];
  bar.innerHTML = `
    <div class="player-inner">
      <div class="player-top">
        <a class="player-title" href="#/s/${esc(ep.seriesId)}/${esc(ep.code)}"><b>${esc(ep.title)}</b> · ${esc(ep.seriesTitle)}</a>
        <span class="player-time" data-el="time"></span>
      </div>
      <input class="scrub" type="range" min="0" max="1000" value="0" aria-label="Position in episode" data-el="scrub">
      <div class="controls">
        <button class="icon-btn" data-act="prev" aria-label="${player.mode === "audio" ? "Back 15 seconds" : "Previous paragraph"}">${ICONS.prev}</button>
        <button class="icon-btn big" data-act="toggle" aria-label="Play">${ICONS.play}</button>
        <button class="icon-btn" data-act="next" aria-label="${player.mode === "audio" ? "Forward 30 seconds" : "Next paragraph"}">${ICONS.next}</button>
      </div>
      <div class="settings">
        <label>Speed
          <select data-el="rate">${speeds.map((s) => `<option value="${s}" ${s === player.rate ? "selected" : ""}>${s}×</option>`).join("")}</select>
        </label>
        ${player.mode === "tts" ? '<label class="voice">Voice <select data-el="voice"></select></label>' : ""}
        ${ep.versions.length > 1 ? `<label class="voice">Version <select data-el="version">${ep.versions.map((v) => `<option value="${esc(v.id)}" ${v === player.version ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>` : ""}
      </div>
    </div>`;
  bar.hidden = false;
  bar.querySelector("[data-act=toggle]").onclick = toggle;
  bar.querySelector("[data-act=prev]").onclick = () => step(-1);
  bar.querySelector("[data-act=next]").onclick = () => step(1);
  bar.querySelector("[data-el=rate]").onchange = (e) => setRate(+e.target.value);
  const ver = bar.querySelector("[data-el=version]");
  if (ver) ver.onchange = () => setVersion(ver.value);
  const scrub = bar.querySelector("[data-el=scrub]");
  scrub.oninput = () => {
    const f = scrub.value / 1000;
    if (player.mode === "audio") {
      if (player.audio.duration) player.audio.currentTime = f * player.audio.duration;
    } else seekBlock(blockAtFraction(f));
  };
  renderVoiceSelect();
  setPlaying(player.playing);
  updateBar();
  requestAnimationFrame(() =>
    document.documentElement.style.setProperty("--player-h", bar.offsetHeight + "px"),
  );
  setupMediaSession();
}

function renderVoiceSelect() {
  const sel = bar.querySelector("[data-el=voice]");
  if (!sel) return;
  const voices = englishVoices().sort((a, b) => rankVoice(b) - rankVoice(a) || a.name.localeCompare(b.name));
  const cur = currentVoice();
  sel.innerHTML = voices.length
    ? voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v === cur ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("")
    : "<option>Default voice</option>";
  sel.onchange = () => {
    player.voiceURI = sel.value;
    store.set("voice", sel.value);
    if (player.playing) play();
  };
}

function updateBar() {
  const ep = player.ep;
  if (!ep || bar.hidden) return;
  const f = fraction();
  const scrub = bar.querySelector("[data-el=scrub]");
  if (scrub && document.activeElement !== scrub) scrub.value = Math.round((player.mode === "audio" ? audioFraction() : f) * 1000);
  const time = bar.querySelector("[data-el=time]");
  if (!time) return;
  if (player.mode === "audio") {
    const a = player.audio;
    time.textContent = `${fmt(a.currentTime)} / ${fmt(a.duration || player.version.durationSec)}`;
  } else {
    const total = ep.durationSec / player.rate;
    time.textContent = `~${mins(total * (1 - f))} left`;
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator) || !player.ep) return;
  const ep = player.ep;
  navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: ep.seriesTitle, album: epNum(ep.code) });
  const handlers = { play, pause, previoustrack: () => step(-1), nexttrack: () => step(1) };
  for (const [k, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(k, fn);
    } catch {
      /* unsupported action */
    }
  }
}

document.addEventListener("keydown", (e) => {
  if (!player.ep || e.target.closest("input, select, textarea, button, a") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " " || e.key === "k") {
    e.preventDefault();
    toggle();
  } else if (e.key === "j") step(-1);
  else if (e.key === "l") step(1);
});
window.addEventListener("pagehide", () => player.ep && save());

// ---------- views ----------
function setView(html, title) {
  view.innerHTML = html;
  document.title = title ? `${title} · Story Reader` : "Story Reader";
  window.scrollTo(0, 0);
  view.focus({ preventScroll: true });
}

function libraryView() {
  const inProgress = [];
  for (const s of catalog.series)
    for (const e of s.episodes) {
      const p = getProgress(s.id, e.code);
      if (p && !p.done && p.frac > 0.01 && p.frac < 1) inProgress.push({ s, e, p });
    }
  inProgress.sort((a, b) => b.p.at - a.p.at);

  const cont = inProgress.slice(0, 3).map(({ s, e, p }) => `
    <a class="card continue" href="#/s/${esc(s.id)}/${esc(e.code)}">
      <span class="play-dot">${ICONS.play}</span>
      <span style="flex:1;min-width:0">
        <span class="eyebrow">${esc(s.title)} · ${epNum(e.code)}</span>
        <h2 style="margin:2px 0 0">${esc(e.title)}</h2>
        <span class="meter"><span style="width:${Math.round(p.frac * 100)}%"></span></span>
      </span>
    </a>`).join("");

  const series = catalog.series.map((s) => `
    <a class="card" href="#/s/${esc(s.id)}">
      <span class="eyebrow">${s.episodes.length} episode${s.episodes.length === 1 ? "" : "s"} · Season ${s.season}</span>
      <h2>${esc(s.title)}</h2>
      ${s.logline ? `<p>${esc(s.logline)}</p>` : ""}
      <div class="tags">${[s.genre, s.contentRating && "Rated " + s.contentRating].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    </a>`).join("");

  setView(`
    <section class="intro">
      <h1>Stories to listen to</h1>
      <p>Serialized fiction, one episode at a time. Press play and read along, or put your phone down and just listen.</p>
    </section>
    ${cont ? `<h2 class="section-title">Continue listening</h2><div class="cards">${cont}</div>` : ""}
    <h2 class="section-title">Series</h2>
    ${series ? `<div class="cards">${series}</div>` : '<p class="empty">No stories are published yet.</p>'}
  `);
}

function seriesView(sid) {
  const s = findSeries(sid);
  if (!s) return notFound();
  const rows = s.episodes.map((e) => {
    const p = getProgress(s.id, e.code);
    const meta = p?.done
      ? '<span class="done">Played</span>'
      : p && p.frac > 0.01
        ? `${mins(e.durationSec * (1 - p.frac))} left`
        : mins(e.durationSec);
    return `<li><a href="#/s/${esc(s.id)}/${esc(e.code)}">
      <span class="ep-num">${esc(String(+e.code.slice(-3)))}</span>
      <span><span class="ep-title">${esc(e.title)}</span>${e.blurb ? `<br><span class="muted" style="font-size:14px">${esc(e.blurb)}</span>` : ""}</span>
      <span class="ep-meta">${meta}</span>
    </a></li>`;
  }).join("");
  setView(`
    <a class="back" href="#/">← All series</a>
    <section class="series-head">
      <span class="eyebrow">Season ${s.season}${s.stage === "pilot" ? " · New series" : ""}</span>
      <h1 style="margin-top:6px">${esc(s.title)}</h1>
      ${s.logline ? `<p>${esc(s.logline)}</p>` : ""}
      <div class="tags">${[s.genre, s.contentRating && "Rated " + s.contentRating].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    </section>
    <ol class="episodes">${rows}</ol>
  `, s.title);
}

async function episodeView(sid, code) {
  const s = findSeries(sid);
  const meta = s?.episodes.find((e) => e.code === code);
  if (!meta) return notFound();
  view.innerHTML = '<p class="empty">Loading…</p>';
  let ep;
  try {
    ep = await loadEpisode(sid, code);
  } catch (err) {
    return setView(`<p class="error">Couldn't load this episode. ${esc(err.message)}</p>`);
  }
  if (location.hash !== `#/s/${sid}/${code}`) return; // navigated away while loading

  const key = epKey(ep);
  const next = nextEpisode(sid, code);
  const body = ep.blocks.map((b, i) =>
    b.type === "break"
      ? '<div class="scene-break" aria-hidden="true">* * *</div>'
      : b.type === "heading"
        ? `<h3 data-block="${i}">${esc(b.text)}</h3>`
        : `<p data-block="${i}">${esc(b.text)}</p>`,
  ).join("");
  const narrationNote = ep.audio
    ? ""
    : tts
      ? `<p class="notice">Narrated by your browser's built-in voice. Pick a different voice in the player; "Natural" or "Online" voices sound best. Keep this tab open while listening.</p>`
      : `<p class="notice">Your browser can't narrate this episode yet. You can still read it below.</p>`;

  setView(`
    <a class="back" href="#/s/${esc(sid)}">← ${esc(s.title)}</a>
    <section class="episode-head">
      <span class="eyebrow">${epNum(code)}</span>
      <h1>${esc(ep.title)}</h1>
      <p class="muted">${mins(ep.durationSec)} · ${ep.wordCount.toLocaleString()} words</p>
      ${ep.audio || tts ? `<div class="start-row"><button class="btn primary" data-act="start" data-ep="${esc(key)}">${ICONS.play} ${startLabel(ep)}</button></div>` : ""}
      ${narrationNote}
    </section>
    <article class="script" data-ep="${esc(key)}">${body}</article>
    <div class="end-card" data-ep="${esc(key)}" ${getProgress(sid, code)?.done ? "" : "hidden"}>
      <p>End of episode.</p>
      ${next ? `<a class="btn primary" href="#/s/${esc(sid)}/${esc(next.code)}">${ICONS.play} Next: ${esc(next.title)}</a>` : `<p class="muted" style="margin:0">Episode ${+code.slice(-3) + 1} is on its way.</p>`}
    </div>
  `, `${ep.title} · ${s.title}`);

  // Don't hijack a different episode that is still playing.
  if (!player.ep || !player.playing) await loadIntoPlayer(ep);

  view.querySelector("[data-act=start]")?.addEventListener("click", async () => {
    if (player.ep !== ep) {
      await loadIntoPlayer(ep);
      play();
    } else toggle();
  });
  view.querySelector(".script").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-block]");
    if (!el || window.getSelection()?.toString()) return;
    if (player.ep !== ep) await loadIntoPlayer(ep);
    seekBlock(+el.dataset.block);
    if (!player.playing) play();
  });
  setPlaying(player.playing);
  if (player.ep === ep && (player.playing || player.block > 0)) highlight(true, true);
}

function notFound() {
  setView('<a class="back" href="#/">← All series</a><p class="empty">That story isn\'t here.</p>', "Not found");
}

async function route() {
  try {
    await loadCatalog();
  } catch (err) {
    return setView(`<p class="error">Couldn't load the library. ${esc(err.message)}</p>`);
  }
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s" && parts[1] && parts[2]) return episodeView(parts[1], parts[2]);
  if (parts[0] === "s" && parts[1]) return seriesView(parts[1]);
  return libraryView();
}

window.addEventListener("hashchange", route);
route();
