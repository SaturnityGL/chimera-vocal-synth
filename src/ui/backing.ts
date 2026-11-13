/**
 * The backing under an imported MIDI's sung line: the file's other tracks on a small Web Audio
 * piano (not the voice engine), scheduled a moment ahead on the audio clock.
 */
import { engine } from "../audio/AudioEngine.ts";

export interface BackingNote {
  t: number;
  dur: number;
  midi: number;
  vel: number;
  track: number;
}

const AHEAD = 0.3;
const TICK = 60;
const HARMONICS = [0, 1, 0.55, 0.32, 0.22, 0.14, 0.09, 0.06, 0.04, 0.025];

const waves = new WeakMap<BaseAudioContext, PeriodicWave>();
let run: { timer: ReturnType<typeof setInterval>; out: GainNode; oscs: Set<OscillatorNode> } | null = null;

function piano(ctx: BaseAudioContext): PeriodicWave {
  let w = waves.get(ctx);
  if (!w) {
    w = ctx.createPeriodicWave(new Float32Array(HARMONICS.length), Float32Array.from(HARMONICS));
    waves.set(ctx, w);
  }
  return w;
}

function strike(ctx: BaseAudioContext, out: AudioNode, oscs: Set<OscillatorNode>, at: number, dur: number, midi: number, vel: number): void {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const v = Math.max(0.05, Math.min(1, vel / 127));
  const peak = 0.11 * v * v + 0.02;
  const hold = Math.max(0.06, dur);
  const decay = Math.max(0.25, Math.min(1.6, 260 / f));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.004);
  g.gain.setTargetAtTime(peak * 0.2, at + 0.004, decay);
  g.gain.setTargetAtTime(0, at + hold, 0.07);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(Math.min(16000, f * (3 + 7 * v)), at);
  lp.frequency.setTargetAtTime(Math.min(16000, f * 1.6), at + 0.01, decay * 0.8);
  lp.connect(g).connect(out);
  let left = 2;
  for (const cents of [-3, 3]) {
    const o = ctx.createOscillator();
    o.setPeriodicWave(piano(ctx));
    o.frequency.value = f;
    o.detune.value = cents;
    o.connect(lp);
    o.start(at);
    o.stop(at + hold + 0.5);
    oscs.add(o);
    o.onended = () => {
      oscs.delete(o);
      o.disconnect();
      if (--left === 0) {
        lp.disconnect();
        g.disconnect();
      }
    };
  }
}

/**
 * Play `notes` (sorted by t, ms from the take's zero) starting at `startAt` (performance.now() ms),
 * `tempo` times as fast and `shift` semitones up; a track whose `on(track)` is false stays quiet.
 */
export function startBacking(notes: BackingNote[], startAt: number, tempo: number, shift: number, on: (track: number) => boolean): void {
  stopBacking();
  const dest = engine.backingOut();
  if (!dest || !notes.length) return;
  const ctx = dest.context;
  const out = ctx.createGain();
  out.connect(dest);
  const oscs = new Set<OscillatorNode>();
  const zero = ctx.currentTime + (startAt - performance.now()) / 1000;
  let next = 0;
  const tick = () => {
    const until = ctx.currentTime + AHEAD;
    while (next < notes.length) {
      const n = notes[next];
      const at = zero + n.t / tempo / 1000;
      if (at > until) break;
      next++;
      if (at < ctx.currentTime - 0.05 || !on(n.track)) continue;
      const midi = n.midi + shift;
      if (midi < 12 || midi > 120) continue;
      strike(ctx, out, oscs, Math.max(at, ctx.currentTime), n.dur / tempo / 1000, midi, n.vel);
    }
    if (next >= notes.length && run) clearInterval(run.timer);
  };
  run = { timer: setInterval(tick, TICK), out, oscs };
  tick();
}

/** Stop the backing at once (a short fade, no click). */
export function stopBacking(): void {
  const r = run;
  if (!r) return;
  run = null;
  clearInterval(r.timer);
  const ctx = r.out.context;
  r.out.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
  for (const o of r.oscs) {
    try {
      o.stop(ctx.currentTime + 0.2);
    } catch {
      // not started yet: it never sounds
    }
  }
  setTimeout(() => r.out.disconnect(), 400);
}
