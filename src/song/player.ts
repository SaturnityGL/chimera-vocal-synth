/**
 * The Song page's playback: a fitted song planned whole (as Sing's demo songs are) and sung by the
 * live engine, with the syllable at the mouth following the voice's clock.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { planSong } from "../wasm/engine.ts";
import { sungWords, wordAt, type SungWords } from "../show/words.ts";
import type { MouthWord } from "../ui/mouthWords.ts";
import type { BodyMix, SungNote } from "../wasm/types.ts";

/** plan time of the first beat (its onset consonants come before) */
const T0 = 0.35;
/** held a little past the plan's end: the last breath out */
const TAIL = 0.4;

interface Run {
  id: number;
  words: SungWords;
  end: number;
  /** voice clock of plan time 0, once the worklet has it */
  offset: number | null;
  onEnd?: () => void;
}

let run: Run | null = null;

export const useSong = create<{ playing: boolean }>(() => ({ playing: false }));

engine.onPlanned((m) => {
  if (run && m.id === run.id) run.offset = m.t0;
});

/** Sing `notes` (after the audio has started); `onEnd` runs when it has been sung through. */
export function playSong(notes: SungNote[], bpm: number, body: BodyMix, onEnd?: () => void): void {
  stopSong();
  if (!notes.length) return;
  const plan = planSong(notes, { body, bpm, t0: T0, vibrato: 35 });
  const words = sungWords({ bpm, t0: T0, lyrics: "", notes: notes.map((n) => [n.midi, n.beats]) }, notes.map((n) => n.syl));
  const id = engine.schedule({ gestures: plan.gestures, segments: plan.segments, end: plan.end });
  run = { id, words, end: plan.end, offset: null, onEnd };
  useSong.setState({ playing: true });
}

/** Stop singing now (onEnd is not called). */
export function stopSong(): void {
  if (!run) return;
  run = null;
  engine.stopSpeech();
  useSong.setState({ playing: false });
}

const elapsed = (r: Run) => (r.offset === null ? null : (engine.voiceClock() ?? 0) - r.offset);

/** Call while the page is shown: ends the song once it has been sung. */
export function tickSong(): void {
  const r = run;
  const t = r && elapsed(r);
  if (!r || t === null || t < r.end + TAIL) return;
  run = null;
  useSong.setState({ playing: false });
  r.onEnd?.();
}

/** The syllable being sung now, for the words at the mouth. */
export function songWord(): MouthWord | null {
  const r = run;
  const t = r && elapsed(r);
  return r && t !== null ? wordAt(r.words, t) : null;
}
