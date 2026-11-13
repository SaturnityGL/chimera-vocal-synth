/**
 * Sing mode on the main thread. The lyrics become syllables with a cursor; each key sings the
 * next syllable at its pitch. A key pressed while the previous one is still down sings legato
 * (the previous syllable's coda runs straight into the next onset); a "-" in the lyrics holds
 * the vowel onto a new pitch (melisma). Releasing the sounding key while another is still down
 * glides back to that key on the same vowel. Key velocity sets the breath.
 * Sing sings the same words to a tune (src/song): fitted to its phrases, planned whole (planSong)
 * and sent as one score. The words, tune, tempo and key are kept on the device.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { g2p } from "./speech.ts";
import { lyricsToSyllables, type Syllable } from "../wasm/engine.ts";
import { planSong, planNoteOn, planNoteOff, planMelisma } from "../wasm/engine.ts";
import { EXHALE_LABEL } from "../wasm/engine.ts";
import type { Gesture } from "../wasm/types.ts";
import { nearestBody, type BodyMix } from "./body.ts";
import { TUNES } from "../song/tunes.ts";
import { fitSong, la } from "../song/fit.ts";

/** A note on the piano roll, on the voice clock (s); t1 is null while it is held. */
export interface RollNote {
  midi: number;
  t0: number;
  t1: number | null;
  text: string;
  demo: boolean;
}

/** What the piano roll draws, read every frame (mutated in place: no re-render per note). */
export const roll: { notes: RollNote[] } = { notes: [] };

export const DEFAULT_LYRICS = "Hello there, I am a voice made of air.";

/** sung when the lyrics are empty */
const AH: Syllable = { text: "ah", onset: [], nucleus: { ipa: "ɑ", stress: 1 }, coda: [], wordEnd: true, phraseEnd: false };

/** the Tune menu's entry for what the keys last sang */
export const TAKE_ID = "take";

/** A key going down (vel ≥ 0) or up (vel −1), `t` ms into the take. */
export interface TakeEvent {
  t: number;
  midi: number;
  vel: number;
}

/** What the keys sang: the words they sang, the syllable they started on, every key down and up. */
export interface Take {
  lyrics: string;
  start: number;
  events: TakeEvent[];
  /** the MIDI file it came from, if imported: then it sings whatever the Lyrics box says */
  source?: string;
}

interface SingState {
  lyrics: string;
  syllables: Syllable[];
  /** the syllable the next key sings */
  cursor: number;
  /** vibrato depth on held vowels (cents) */
  vibrato: number;
  /** the tune Sing sings the words to (a TUNES id) */
  tune: string;
  /** the tune's tempo, as a multiple of its own */
  tempo: number;
  /** semitones up or down from the tune's own key (after the body's octave) */
  key: number;
  /** the tune being sung, if any */
  playing: string | null;
  /** index in `syllables` of the one the tune is singing (−1: none, or the tune sings "la") */
  at: number;
  /** what the keys last sang, which Sing plays back as the tune "take" */
  take: Take | null;
  clearTake: () => void;
  setLyrics: (text: string) => void;
  setCursor: (i: number) => void;
  setVibrato: (cents: number) => void;
  setTune: (id: string) => void;
  setTempo: (x: number) => void;
  setKey: (semitones: number) => void;
}

const KEPT = "chimera-sing";

/** the last session's words, tune, tempo and key (anything missing or odd: the defaults) */
function kept(): { lyrics: string; tune: string; tempo: number; key: number } {
  const d = { lyrics: DEFAULT_LYRICS, tune: TUNES[0].id, tempo: 1, key: 0 };
  try {
    const k = JSON.parse(localStorage.getItem(KEPT) ?? "null") as Record<string, unknown> | null;
    if (!k) return d;
    return {
      lyrics: typeof k.lyrics === "string" ? k.lyrics : d.lyrics,
      tune: k.tune === TAKE_ID || TUNES.some((t) => t.id === k.tune) ? (k.tune as string) : d.tune,
      tempo: typeof k.tempo === "number" && k.tempo >= 0.5 && k.tempo <= 1.5 ? k.tempo : d.tempo,
      key: typeof k.key === "number" && Math.abs(k.key) <= 12 ? Math.round(k.key) : d.key,
    };
  } catch {
    return d; // no storage here (a private window): start fresh
  }
}

const KEPT_TAKE = "chimera-take";
/** a take's length cap, in key downs and ups */
const TAKE_MAX = 4000;

/** the last session's take, if it reads as one */
function keptTake(): Take | null {
  try {
    const k = JSON.parse(localStorage.getItem(KEPT_TAKE) ?? "null") as Partial<Take> | null;
    if (!k || typeof k.lyrics !== "string" || typeof k.start !== "number" || !Array.isArray(k.events)) return null;
    const events = k.events.filter((e): e is TakeEvent => !!e && typeof e.t === "number" && typeof e.midi === "number" && typeof e.vel === "number").slice(0, TAKE_MAX);
    if (!events.some((e) => e.vel >= 0)) return null;
    const take: Take = { lyrics: k.lyrics, start: Math.max(0, Math.round(k.start)), events };
    if (typeof k.source === "string") take.source = k.source;
    return take;
  } catch {
    return null;
  }
}

/** the take the keys are adding to: a new one starts on the first key after the words or the start syllable change */
let taking: { t0: number; take: Take } | null = null;

const atLoad = kept();
const takeAtLoad = keptTake();

export const useSing = create<SingState>((set, get) => ({
  lyrics: atLoad.lyrics,
  syllables: lyricsToSyllables(atLoad.lyrics),
  cursor: 0,
  vibrato: 35,
  tune: atLoad.tune === TAKE_ID && !takeAtLoad ? TUNES[0].id : atLoad.tune,
  tempo: atLoad.tempo,
  key: atLoad.key,
  playing: null,
  at: -1,
  take: takeAtLoad,
  clearTake: () => {
    if (get().playing === TAKE_ID) stopDemo();
    taking = null;
    set((s) => ({ take: null, tune: s.tune === TAKE_ID ? TUNES[0].id : s.tune }));
  },
  setLyrics: (text) => {
    stopDemo();
    taking = null;
    const take = get().take;
    set({ lyrics: text, syllables: lyricsToSyllables(text), cursor: 0, take: take?.source ? { ...take, lyrics: text, start: 0 } : take });
  },
  setCursor: (i) => {
    taking = null;
    set({ cursor: Math.max(0, Math.min(i, Math.max(0, get().syllables.length - 1))) });
  },
  setVibrato: (cents) => set({ vibrato: cents }),
  setTune: (id) => set({ tune: id }),
  setTempo: (x) => set({ tempo: x }),
  setKey: (semitones) => set({ key: semitones }),
}));

useSing.subscribe((s, p) => {
  if (s.lyrics === p.lyrics && s.tune === p.tune && s.tempo === p.tempo && s.key === p.key) return;
  try {
    localStorage.setItem(KEPT, JSON.stringify({ lyrics: s.lyrics, tune: s.tune, tempo: s.tempo, key: s.key }));
  } catch {
    // not kept: the session still works
  }
});

/** the take is written out once the keys have been quiet a moment, not on every key */
let takeSave: ReturnType<typeof setTimeout> | null = null;
useSing.subscribe((s, p) => {
  if (s.take === p.take) return;
  if (takeSave) clearTimeout(takeSave);
  takeSave = setTimeout(() => {
    takeSave = null;
    try {
      const t = useSing.getState().take;
      if (t) localStorage.setItem(KEPT_TAKE, JSON.stringify(t));
      else localStorage.removeItem(KEPT_TAKE);
    } catch {
      // not kept: the take still plays this session
    }
  }, 800);
});

/** Load the pronouncing dictionary, then re-read the lyrics with it (the cursor stays). */
export function ensureDictionary(): void {
  if (g2p.loaded) return;
  g2p
    .load()
    .then(() => {
      const s = useSing.getState();
      const syllables = lyricsToSyllables(s.lyrics);
      useSing.setState({ syllables, cursor: Math.min(s.cursor, Math.max(0, syllables.length - 1)) });
    })
    .catch(() => {
      // no dictionary: the letter-to-sound rules keep working
    });
}

// ---- live notes

interface Sounding {
  midi: number;
  /** the syllable whose vowel is sounding (a melisma keeps its parent's, for the coda) */
  syl: Syllable;
  tag: number;
  note: RollNote;
}

let sounding: Sounding | null = null;

/** How a syllable is written at the mouth: a hyphen when its word goes on. */
const written = (s: Syllable) => s.text + (s.wordEnd ? "" : "-");

/**
 * The syllable being sung now, for the words at the mouth: the demo's note under the clock, or
 * the held key's. A melisma keeps its syllable's key, so the word stays while the pitch moves.
 */
export function sungNow(): { key: unknown; text: string } | null {
  const d = demoRun;
  if (d) {
    if (d.offset === null) return null;
    const t = now() - d.offset;
    // notes follow one another without a gap, so a melisma's syllable stays put
    const k = d.times.findIndex(([a, b]) => t >= a && t < b);
    return k < 0 ? null : { key: `${d.id}:${d.parent[k]}`, text: d.shown[k] };
  }
  return sounding ? { key: sounding, text: written(sounding.syl) } : null;
}

/** The syllable whose vowel is sounding from the keys now (null when no key sings). */
export function soundingSyllable(): string | null {
  return sounding?.syl.text ?? null;
}
/** keys down, oldest first */
let keys: number[] = [];
/** gesture tags: a note uses tag (articulation, breath) and tag + 1 (pitch, vibrato) */
let nextTag = 2;
/** endings (glide, coda) that may still be playing: tag, and tag + 1 for the breath-out */
const tails: number[] = [];
/** endings whose breath-out has not been dropped by a following note */
let exhalesLive = false;

/** breath level for a key velocity (1 at the on-screen keys' default of 96) */
const breathFor = (velocity: number) => 0.62 + 0.4 * Math.min(1, Math.max(0, velocity / 96)) + 0.12 * Math.max(0, (velocity - 96) / 31);

const now = () => engine.voiceClock() ?? 0;

function addNote(midi: number, t0: number, text: string, demo = false, t1: number | null = null): RollNote {
  const n: RollNote = { midi, t0, t1, text, demo };
  roll.notes.push(n);
  // keep a minute of history
  const cut = t0 - 60;
  if (roll.notes.length > 400 || (roll.notes[0] && (roll.notes[0].t1 ?? t0) < cut)) roll.notes = roll.notes.filter((x) => (x.t1 ?? t0) >= cut).slice(-400);
  return n;
}

/** The syllable a melisma at index i continues. */
function parentOf(syls: Syllable[], i: number): Syllable {
  for (let k = i; k >= 0; k--) if (!syls[k].melisma) return syls[k];
  return AH;
}

function startNote(syl: Syllable, midi: number, velocity: number, body: BodyMix, text: string): void {
  const t = now();
  const tag = nextTag;
  nextTag += 2;
  // earlier codas may finish, but their breath-out must not open the folds on this onset
  if (exhalesLive) for (const t of tails) engine.release(t + 1);
  exhalesLive = false;
  const from = sounding;
  if (from) {
    engine.release(from.tag);
    engine.release(from.tag + 1);
    from.note.t1 = t;
  }
  const gs: Gesture[] = planNoteOn(syl, midi, { body, vibrato: useSing.getState().vibrato, tag, legatoFrom: from ? { syl: from.syl, midi: from.midi } : undefined });
  const breath = breathFor(velocity);
  for (const g of gs) if (g.targets.breath !== undefined) g.targets = { ...g.targets, breath: g.targets.breath * breath };
  engine.scheduleGestures(gs);
  sounding = { midi, syl, tag, note: addNote(midi, t, text) };
}

/** The held vowel moves to a new pitch (melisma, or back to a key still down). */
function glide(midi: number, text: string): void {
  const s = sounding!;
  const t = now();
  engine.release(s.tag + 1);
  engine.scheduleGestures(planMelisma(midi, { vibrato: useSing.getState().vibrato, tag: s.tag }));
  s.note.t1 = t;
  s.midi = midi;
  s.note = addNote(midi, t, text);
}

/** Key `midi` sings syllable i of `syls`; returns the index of the next. */
function noteOn(midi: number, velocity: number, body: BodyMix, syls: Syllable[], i: number): number {
  keys = keys.filter((k) => k !== midi).concat(midi);
  const syl = syls[i];
  if (syl.melisma && sounding) glide(midi, syl.text);
  // a melisma with nothing held: sing its vowel again, without the onset
  else startNote(syl.melisma ? { ...parentOf(syls, i), onset: [] } : syl, midi, velocity, body, syl.text);
  return (i + 1) % syls.length;
}

/** The record of the take being played now, if the keys are playing one. */
function record(midi: number, vel: number): void {
  const t = performance.now();
  if (!taking) {
    if (vel < 0) return;
    const st = useSing.getState();
    if (st.take?.source) return;
    taking = { t0: t, take: { lyrics: st.lyrics, start: st.cursor, events: [] } };
  }
  const tk = taking.take;
  if (tk.events.length >= TAKE_MAX) return;
  taking.take = { ...tk, events: [...tk.events, { t: Math.round(t - taking.t0), midi, vel }] };
  useSing.setState({ take: taking.take, tune: TAKE_ID });
}

/** each event's time in the take as it plays back (ms): pauses the keys left longer than TAKE_GAP are cut to it */
export function takeTimes(take: Take): number[] {
  const { events } = take;
  const gap = take.source ? Infinity : TAKE_GAP;
  const out: number[] = [];
  events.forEach((e, k) => out.push(k ? out[k - 1] + Math.max(0, Math.min(gap, e.t - events[k - 1].t)) : 0));
  return out;
}

/** Make a MIDI file's melody the take, sung to the Lyrics box one syllable a note. */
export function importTake(source: string, notes: { t: number; dur: number; midi: number; vel: number }[]): void {
  const first = notes[0]?.t ?? 0;
  const events: TakeEvent[] = [];
  for (const n of notes) {
    const t0 = Math.round(n.t - first);
    events.push({ t: t0, midi: n.midi, vel: Math.max(1, Math.min(127, n.vel)) }, { t: t0 + Math.max(1, Math.round(n.dur)), midi: n.midi, vel: -1 });
  }
  events.sort((a, b) => a.t - b.t || (a.vel < 0 ? -1 : 0) - (b.vel < 0 ? -1 : 0));
  stopDemo();
  taking = null;
  const st = useSing.getState();
  useSing.setState({ take: { lyrics: st.lyrics, start: 0, events: events.slice(0, TAKE_MAX), source }, tune: TAKE_ID, cursor: 0 });
}

/** One sung note of a take: its key-down and key-up events (off −1: none), when (ms) and what. */
export interface TakeBlock {
  on: number;
  off: number;
  t0: number;
  t1: number;
  midi: number;
  text: string;
  /** index of its syllable in the take's lyrics */
  syl: number;
}

/** The take's notes as blocks on its playback clock, each with the syllable it sings. */
export function takeBlocks(take: Take): TakeBlock[] {
  const times = takeTimes(take);
  const own = lyricsToSyllables(take.lyrics);
  const syls = own.length ? own : [AH];
  let i = take.start % syls.length;
  const open = new Map<number, TakeBlock>();
  const out: TakeBlock[] = [];
  take.events.forEach((e, k) => {
    const held = open.get(e.midi);
    if (held) {
      held.t1 = times[k];
      if (e.vel < 0) held.off = k;
      open.delete(e.midi);
    }
    if (e.vel < 0) return;
    const b: TakeBlock = { on: k, off: -1, t0: times[k], t1: times[k], midi: e.midi, text: syls[i].text, syl: i };
    i = (i + 1) % syls.length;
    open.set(e.midi, b);
    out.push(b);
  });
  const end = (times[times.length - 1] ?? 0) + 300;
  for (const b of open.values()) b.t1 = end;
  return out;
}

/** Move a take's note (its key-down and key-up) to another pitch. */
export function moveTakeNote(b: TakeBlock, midi: number): void {
  const take = useSing.getState().take;
  if (!take || !take.events[b.on]) return;
  const m = Math.max(24, Math.min(96, Math.round(midi)));
  const events = take.events.slice();
  events[b.on] = { ...events[b.on], midi: m };
  if (b.off >= 0 && events[b.off]) events[b.off] = { ...events[b.off], midi: m };
  const next = { ...take, events };
  if (taking?.take === take) taking.take = next;
  useSing.setState({ take: next });
}

/** Sing one of the take's syllables briefly at `midi` (after a note is moved), unless a song is playing. */
export function auditionTake(b: TakeBlock, midi: number, body: BodyMix): void {
  const st = useSing.getState();
  if (!st.take || st.playing || sounding) return;
  const own = lyricsToSyllables(st.take.lyrics);
  const syls = own.length ? own : [AH];
  const syl = syls[b.syl % syls.length];
  const say = syl.melisma ? [{ ...parentOf(syls, b.syl % syls.length), melisma: false, text: syl.text }] : [syl];
  noteOn(midi, 96, body, say, 0);
  setTimeout(() => noteOff(midi, body, undefined), 380);
}

/** where the take playing back is (ms on its playback clock), or null */
export function takePlayhead(): number | null {
  const r = replay;
  return r ? (performance.now() - r.startAt - TAKE_LEAD) * r.tempo : null;
}

export function singNoteOn(midi: number, velocity: number, body: BodyMix): void {
  stopDemo();
  record(midi, velocity);
  const st = useSing.getState();
  const syls = st.syllables.length ? st.syllables : [AH];
  useSing.setState({ cursor: noteOn(midi, velocity, body, syls, st.cursor % syls.length) });
}

export function singNoteOff(midi: number, body: BodyMix): void {
  if (keys.includes(midi)) record(midi, -1);
  const st = useSing.getState();
  noteOff(midi, body, st.syllables[st.cursor]);
}

function noteOff(midi: number, body: BodyMix, next: Syllable | undefined): void {
  keys = keys.filter((k) => k !== midi);
  const s = sounding;
  if (!s || s.midi !== midi) return;
  if (keys.length) {
    glide(keys[keys.length - 1], "~");
    return;
  }
  engine.release(s.tag);
  engine.release(s.tag + 1);
  s.note.t1 = now();
  sounding = null;
  // a melisma comes next: this vowel carries on there, and the coda waits for the chain's end
  if (next?.melisma) return;
  const gs = planNoteOff(s.syl, midi, body);
  if (!gs.length) return;
  const tag = nextTag;
  nextTag += 2;
  engine.scheduleGestures(gs.map((g) => ({ ...g, tag: g.label === EXHALE_LABEL ? tag + 1 : tag })));
  tails.push(tag);
  if (tails.length > 8) tails.shift(); // long finished by now
  exhalesLive = true;
}

// ---- tunes

interface TuneRun {
  id: number;
  /** note start/end times in plan time (s) */
  times: [number, number][];
  midi: number[];
  text: string[];
  /** what the mouth shows per note, and the note whose syllable it is (a melisma's parent) */
  shown: string[];
  parent: number[];
  /** each note's syllable in the lyrics (−1: the tune sings "la") */
  from: number[];
  end: number;
  /** voice clock of plan time 0, once the worklet has it */
  offset: number | null;
  hooks: TuneHooks;
}

/** What a caller (Video) does as a tune's run begins, ends or is stopped. */
export interface TuneHooks {
  /** just before it's sent to the voice, after every wait (a throw: it isn't sung) */
  onStart?: () => void;
  /** sung to the end */
  onEnd?: () => void;
  /** stopped before the end, from anywhere (Stop, another tune, the mode or body changing) */
  onStop?: () => void;
}

let demoRun: TuneRun | null = null;
/** bumped by every stop: a tune still waiting for audio or the dictionary then gives up */
let demoToken = 0;

function endDemo(): void {
  demoRun = null;
  useSing.setState({ playing: null, at: -1 });
}

engine.onPlanned((m) => {
  const d = demoRun;
  if (!d || m.id !== d.id) return;
  d.offset = m.t0;
  d.times.forEach(([a, b], k) => addNote(d.midi[k], m.t0 + a, d.text[k], true, m.t0 + b - 0.02));
});

/**
 * Sing the lyrics to tune `id` (after `ready`, e.g. audio startup, resolves; unless stopped
 * meanwhile), at the chosen tempo and key; empty lyrics sing it on "la". Resolves whether it is
 * singing. `hooks` follow the run: onStart only once nothing can cancel it before it's sent.
 */
export async function playTune(id: string, body: BodyMix, ready?: () => Promise<void>, hooks: TuneHooks = {}): Promise<boolean> {
  if (id === TAKE_ID) return playTake(body, ready, hooks);
  const tune = TUNES.find((t) => t.id === id);
  if (!tune) return false;
  stopSinging();
  const token = demoToken;
  await ready?.();
  try {
    await g2p.load();
  } catch {
    // letter-to-sound rules
  }
  if (token !== demoToken) return false;
  const st = useSing.getState();
  // read again: the dictionary may have arrived since the words were typed
  const own = lyricsToSyllables(st.lyrics);
  const words = own.length ? own : lyricsToSyllables(la(tune));
  const { notes, from } = fitSong(tune, words, tune.octave[nearestBody(body)] * 12 + st.key);
  if (!notes.length) return false;
  const bpm = tune.bpm * st.tempo;
  const t0 = 0.35;
  const plan = planSong(notes, { body, bpm, t0, vibrato: st.vibrato });
  hooks.onStart?.();
  const beat = 60 / bpm;
  let t = t0;
  const times = notes.map((n): [number, number] => {
    const a = t;
    t += n.beats * beat;
    return [a, t];
  });
  const planId = engine.schedule({ gestures: plan.gestures, segments: plan.segments, end: plan.end });
  const parent: number[] = [];
  notes.forEach((n, i) => parent.push(n.syl.melisma && i > 0 ? parent[i - 1] : i));
  const shown = parent.map((p) => written(notes[p].syl));
  demoRun = { id: planId, times, midi: notes.map((n) => n.midi), text: notes.map((n) => n.syl.text), shown, parent, from: own.length ? from : from.map(() => -1), end: plan.end, offset: null, hooks };
  useSing.setState({ syllables: own, cursor: Math.min(st.cursor, Math.max(0, own.length - 1)), playing: tune.id, at: -1 });
  return true;
}

/** a pause in a take longer than this plays back as this long (ms) */
const TAKE_GAP = 2000;

/** silence before a take's first note (ms) */
const TAKE_LEAD = 150;

let replay: { timer: ReturnType<typeof setTimeout> | null; hooks: TuneHooks; startAt: number; tempo: number } | null = null;

function releaseKeys(): void {
  if (sounding) {
    engine.release(sounding.tag);
    engine.release(sounding.tag + 1);
    sounding.note.t1 = now();
    sounding = null;
  }
  keys = [];
}

/** Sing the take back through the keys' own path, at the chosen tempo and key. */
async function playTake(body: BodyMix, ready?: () => Promise<void>, hooks: TuneHooks = {}): Promise<boolean> {
  const take = useSing.getState().take;
  if (!take) return false;
  stopSinging();
  const token = demoToken;
  await ready?.();
  try {
    await g2p.load();
  } catch {
    // letter-to-sound rules
  }
  if (token !== demoToken) return false;
  const st = useSing.getState();
  const own = lyricsToSyllables(take.lyrics);
  const syls = own.length ? own : [AH];
  const same = take.lyrics === st.lyrics;
  const shift = st.key;
  const tempo = st.tempo;
  const events = take.events;
  const times = takeTimes(take);
  let i = take.start % syls.length;
  hooks.onStart?.();
  const run = { timer: null as ReturnType<typeof setTimeout> | null, hooks, startAt: performance.now(), tempo };
  const due = (k: number) => Math.max(0, run.startAt + TAKE_LEAD + times[k] / tempo - performance.now());
  replay = run;
  useSing.setState({ playing: TAKE_ID, at: -1 });
  const step = (k: number) => {
    if (replay !== run) return;
    if (k >= events.length) {
      for (const m of [...keys]) noteOff(m, body, syls[i]);
      run.timer = setTimeout(() => {
        if (replay !== run) return;
        replay = null;
        useSing.setState({ playing: null, at: -1 });
        hooks.onEnd?.();
      }, 400);
      return;
    }
    const e = events[k];
    if (e.vel >= 0) {
      const at = i;
      i = noteOn(e.midi + shift, e.vel, body, syls, i);
      if (same) useSing.setState({ at });
    } else noteOff(e.midi + shift, body, syls[i]);
    run.timer = setTimeout(() => step(k + 1), k + 1 < events.length ? due(k + 1) : 0);
  };
  run.timer = setTimeout(() => step(0), due(0));
  return true;
}

function stopDemo(): void {
  demoToken++;
  const r = replay;
  if (r) {
    replay = null;
    if (r.timer) clearTimeout(r.timer);
    releaseKeys();
    useSing.setState({ playing: null, at: -1 });
    r.hooks.onStop?.();
  }
  const d = demoRun;
  if (!d) return;
  engine.stopSpeech();
  // notes not yet sung leave the roll; the one sounding ends now
  const t = now();
  roll.notes = roll.notes.filter((n) => !(n.demo && n.t0 > t));
  for (const n of roll.notes) if (n.demo && n.t1 !== null && n.t1 > t) n.t1 = t;
  endDemo();
  d.hooks.onStop?.();
}

/** Call every frame while Sing mode is shown: follow the tune's progress. */
export function tickSinging(): void {
  const d = demoRun;
  if (!d || d.offset === null) return;
  const t = now() - d.offset;
  if (t > d.end + 0.4) {
    endDemo();
    d.hooks.onEnd?.();
    return;
  }
  let k = -1;
  while (k + 1 < d.times.length && d.times[k + 1][0] <= t) k++;
  const at = k < 0 ? -1 : d.from[k];
  if (at !== useSing.getState().at) useSing.setState({ at });
}

/** Stop everything sung (leaving Sing mode, changing body): demo, notes and endings. */
export function stopSinging(): void {
  stopDemo();
  releaseKeys();
  for (const t of tails) {
    engine.release(t);
    engine.release(t + 1);
  }
  tails.length = 0;
  exhalesLive = false;
}

export { TUNES };
