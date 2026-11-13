import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { useSing, playTune, stopSinging, soundingSyllable, sungNow, TUNES, TAKE_ID, ensureDictionary, importTake } from "../singing.ts";
import { parseMidi, midiBeat, melodyLine, underLine, inRange, pickVocal, type MidiTrack } from "../midifile.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { canRecord, Clip } from "../../song/record.ts";
import { mouthWords } from "../mouthWords.ts";
import { V } from "../colors.ts";
import { Keys, MidiButton } from "./Keys.tsx";
import { ActionBar, PrimaryButton } from "./ActionBar.tsx";
import { Menu } from "./Controls.tsx";
import { PianoRoll } from "./PianoRoll.tsx";
import { TakeEditor, GridTools } from "./TakeEditor.tsx";
import { SpectrumView } from "./SpectrumView.tsx";
import { Chip, Screen } from "./Screen.tsx";
import { EncoderPages } from "./Encoder.tsx";
import { noteName } from "./VoiceControls.tsx";
import type { InfoFn } from "./AnatomyView.tsx";

/** epilarynx narrowing for the singer's ring (measured: +3 to +12 dB at 2.4–3.6 kHz, adult male) */
const RING = 0.85;
const ROLL_VIEW = "chimera-roll-view";

/** the syllable being sung now: the tune's, or the one the held key is singing */
function syllableNow(): string | null {
  const s = useSing.getState();
  if (s.playing) return s.syllables[s.at]?.text ?? null;
  return soundingSyllable();
}

/** the syllable being sung, at the mouth */
export const singWords = mouthWords(sungNow, V.green);

/** Sing mode's lines over the face: the note, the syllable, the ring */
export const singInfo: InfoFn = (_m, _f, tele) => {
  const out: string[] = [];
  if (tele && tele.t.voicing > 0.3) out.push(`Note ${noteName(tele.t.f0)} ${tele.t.f0.toFixed(0)} Hz`);
  const syl = syllableNow();
  if (syl) out.push(`Syllable ${syl}`);
  out.push(useStore.getState().artic.epilarynx >= RING - 0.05 ? "Ring on" : "Ring off");
  return out;
};

function Lyrics() {
  const lyrics = useSing((s) => s.lyrics);
  const syllables = useSing((s) => s.syllables);
  const cursor = useSing((s) => s.cursor);
  const demo = useSing((s) => s.playing);
  const sungAt = useSing((s) => s.at);
  const setLyrics = useSing((s) => s.setLyrics);
  const setCursor = useSing((s) => s.setCursor);
  const at = demo ? sungAt : -1;
  const done = demo ? sungAt : cursor;
  return (
    <div className="lyrics">
      <textarea
        value={lyrics}
        onChange={(e) => setLyrics(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        rows={Math.min(4, lyrics.split("\n").length)}
        aria-label="Lyrics to sing"
        placeholder="Type the words to sing"
        title="Sing sings these words to the tune, a line to each of its phrases. Each key sings the next syllable; hold a key while you press the next one to sing legato. A lone “-” between words holds a vowel over several notes; hyphens split a word your way (“ti-ger”); a “+” after a word sings all of it on one note (“fire+”)."
      />
      <div className="syllables" role="group" aria-label="Syllables. Each note sings the marked one; choose another to start there.">
        {syllables.map((s, i) => (
          <span key={i} className={`syl-wrap${s.wordEnd ? " word-end" : ""}`}>
            <button
              className={`syl${!demo && i === cursor ? " next" : ""}${i === at ? " now" : ""}${i < done ? " sung" : ""}${s.melisma ? " held" : ""}`}
              onClick={() => setCursor(i)}
              aria-current={!demo && i === cursor ? "step" : undefined}
              title={s.melisma ? "Held vowel: carries the previous syllable onto this note" : `Sing from “${s.text}”`}
            >
              {s.text}
            </button>
            {s.phraseEnd && (
              <span className="breath-mark" aria-label="breath">
                ’
              </span>
            )}
          </span>
        ))}
        {!syllables.length && <span className="dim">No words: the keys sing “ah”.</span>}
        <Chip toggle={false} className="from-start" onClick={() => setCursor(0)} disabled={cursor === 0 && !demo}>
          From the start
        </Chip>
      </div>
    </div>
  );
}

function SongControls() {
  const source = useStore((s) => s.source);
  const setSource = useStore((s) => s.setSource);
  const epilarynx = useStore((s) => s.artic.epilarynx);
  const setArtic = useStore((s) => s.setArtic);
  const vibrato = useSing((s) => s.vibrato);
  const setVibrato = useSing((s) => s.setVibrato);
  const tempo = useSing((s) => s.tempo);
  const setTempo = useSing((s) => s.setTempo);
  const key = useSing((s) => s.key);
  const setKey = useSing((s) => s.setKey);
  return (
    <EncoderPages
      label="Song voice"
      pages={[
        {
          name: "Song",
          encoders: [
            { label: "Vibrato", value: vibrato, min: 0, max: 80, onChange: (v) => setVibrato(Math.round(v)), format: (v) => ({ value: String(Math.round(v)), unit: "cents" }) },
            { label: "Rate", value: source.vibratoRate, min: 3.5, max: 7.5, onChange: (v) => setSource({ vibratoRate: v }), format: (v) => ({ value: v.toFixed(1), unit: "Hz" }) },
            { label: "Breathy", value: source.breathiness, min: 0, max: 1, onChange: (v) => setSource({ breathiness: v }), format: (v) => ({ value: String(Math.round(v * 100)), unit: "%" }) },
            // the singer's ring narrows the tube just above the folds, adding the bright band near 3 kHz
            { label: "Ring", value: epilarynx, min: 0, max: 1, onChange: (v) => setArtic({ epilarynx: v }), format: (v) => ({ value: String(Math.round(v * 100)), unit: "%" }) },
          ],
        },
        {
          // the tune's speed and key, from the next time Sing is pressed
          name: "Tune",
          encoders: [
            { label: "Tempo", value: tempo, min: 0.5, max: 1.5, onChange: (v) => setTempo(Math.round(v * 20) / 20), format: (v) => ({ value: String(Math.round(v * 100)), unit: "%" }) },
            { label: "Key", value: key, min: -12, max: 12, onChange: (v) => setKey(Math.round(v)), format: (v) => ({ value: (v > 0.5 ? "+" : "") + String(Math.round(v)), unit: "semitones" }) },
          ],
        },
        {
          name: "Tone",
          encoders: [{ label: "Bright", value: source.brightness, min: 0, max: 1, onChange: (v) => setSource({ brightness: v }), format: (v) => ({ value: String(Math.round(v * 100)), unit: "%" }) }],
        },
      ]}
    />
  );
}

/**
 * Sing's main button: sing the lyrics to the chosen tune, or stop. A song getting ready (audio
 * starting, the dictionary loading) counts as playing: Stop cancels it, and choosing another tune
 * replaces it. Video sings it again into a clip of the face screen (Share and Save once it's done).
 */
function SingActions() {
  const start = useStore((s) => s.start);
  const playing = useSing((s) => s.playing);
  const tune = useSing((s) => s.tune);
  const setTune = useSing((s) => s.setTune);
  const hasTake = useSing((s) => !!s.take);
  const source = useSing((s) => s.take?.source ?? null);
  const clearTake = useSing((s) => s.clearTake);
  const [pending, setPending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<{ file: File; url: string } | null>(null);
  /** bumped by every start and stop: a start still waiting no longer counts */
  const request = useRef(0);
  /** bumped by every Video: a clip still being finished for an earlier one isn't offered */
  const take = useRef(0);
  /** the clip recording now, if any (one at a time) */
  const recorder = useRef<Clip | null>(null);
  // the audio must be running: if it failed to start, nothing is planned and the error shows
  const ready = async () => {
    await start();
    if (!useStore.getState().started) throw new Error("no audio");
  };
  const drop = () => {
    recorder.current?.cancel();
    recorder.current = null;
    setRecording(false);
  };
  // the clip's life is the tune's run: it starts as the tune is sent (never for a start that was
  // cancelled), is saved when it's sung to the end, and goes when it's stopped from anywhere
  const sing = (id: string, record = false) => {
    const n = ++request.current;
    const k = record ? ++take.current : take.current;
    drop();
    setPending(true);
    let mine: Clip | null = null;
    const hooks = !record
      ? {}
      : {
          whole: true,
          onStart: () => {
            const canvas = document.querySelector<HTMLCanvasElement>(".screen.left canvas");
            const audio = engine.recordStream();
            if (n !== request.current || !canvas || !audio) throw new Error("not recording");
            mine = recorder.current = new Clip(canvas, audio);
            setRecording(true);
            setClip(null);
          },
          onEnd: () => {
            const c = mine;
            if (!c || recorder.current !== c) return;
            recorder.current = null;
            setRecording(false);
            void c.stop(`chimera-${id}`).then((file) => take.current === k && setClip({ file, url: URL.createObjectURL(file) }));
          },
          onStop: () => {
            if (mine && recorder.current === mine) drop();
          },
        };
    playTune(id, useStore.getState().body, ready, hooks)
      .catch(() => {})
      .finally(() => request.current === n && setPending(false));
  };
  const stop = () => {
    request.current++; // the song getting ready, if any, no longer counts
    setPending(false);
    stopSinging(); // its run's onStop drops the clip
    drop();
  };
  useEffect(() => () => void (clip && URL.revokeObjectURL(clip.url)), [clip]);
  // leaving Sing: nothing still starting may begin a clip, and one recording goes
  useEffect(
    () => () => {
      request.current++;
      take.current++;
      recorder.current?.cancel();
      recorder.current = null;
    },
    [],
  );
  const press = () => (playing || pending ? stop() : sing(tune));
  const share = clip && typeof navigator.canShare === "function" && navigator.canShare({ files: [clip.file] });
  return (
    <ActionBar label="Song" onSpace={press}>
      <PrimaryButton label="Sing" playing={(!!playing || pending) && !recording} busy={recording ? "Recording…" : null} onClick={press} />
      <Menu
        label="Tune"
        icon="note"
        value={tune}
        options={(hasTake ? [{ value: TAKE_ID, label: source ? `MIDI: ${source}` : "Your take" }] : []).concat(TUNES.map((t) => ({ value: t.id, label: t.name })))}
        onChange={(id) => {
          setTune(id);
          if ((playing || pending) && !recording) sing(id);
        }}
      />
      {hasTake && tune === TAKE_ID && (
        <Chip toggle={false} onClick={clearTake} title={source ? "Drop the imported MIDI (the next key starts a new take)" : "Forget what the keys sang (the next key starts a new take)"}>
          Clear
        </Chip>
      )}
      <MidiImport />
      {canRecord() && (
        <Chip toggle={false} onClick={() => (recording ? stop() : sing(tune, true))} title="Sing it again and record the face into a video">
          {recording ? "Cancel" : "Video"}
        </Chip>
      )}
      {clip && share && (
        <Chip toggle={false} tone="amber" onClick={() => void navigator.share({ files: [clip.file] }).catch(() => {})}>
          Share
        </Chip>
      )}
      {clip && (
        <a className="chip" href={clip.url} download={clip.file.name}>
          Save
        </a>
      )}
    </ActionBar>
  );
}

/** the tracks worth singing, most notes first */
const trackName = (t: MidiTrack, k: number) => t.name || `Track ${k + 1}`;
const LEGATO = "chimera-midi-legato";
const LEGATO_GAP = 1200;

/**
 * Import MIDI: a local .mid file's melody becomes the take (nothing leaves the browser). Its notes
 * keep their timing and sing the Lyrics box a syllable each; a file with several tracks gets a picker
 * for the sung one, and the rest play under it on piano.
 */
function MidiImport() {
  const source = useSing((s) => s.take?.source ?? null);
  const file = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<{ name: string; tracks: MidiTrack[]; pick: number; beat: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [legato, setLegato] = useState(() => {
    try {
      return localStorage.getItem(LEGATO) !== "0";
    } catch {
      return true;
    }
  });
  const use = (name: string, tracks: MidiTrack[], pick: number, beat: number, smooth = legato) => {
    setLoaded({ name, tracks, pick, beat });
    const sung = tracks[pick];
    const line = melodyLine(sung.notes, smooth ? LEGATO_GAP : 0);
    const under = underLine(sung.notes, line);
    const backing = tracks.flatMap((t, k) => (k === pick ? (under.length ? [{ name: `${trackName(t, k)} (under the tune)`, notes: under }] : []) : [{ name: trackName(t, k), notes: t.notes }]));
    importTake(name, line.map((n) => ({ ...n, midi: inRange(n.midi) })), backing, beat);
  };
  const toggleLegato = () => {
    const on = !legato;
    setLegato(on);
    try {
      localStorage.setItem(LEGATO, on ? "1" : "0");
    } catch {
      // not kept: this session still uses it
    }
    if (loaded && source === loaded.name) use(loaded.name, loaded.tracks, loaded.pick, loaded.beat, on);
  };
  const open = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const buf = await f.arrayBuffer();
      const tracks = parseMidi(buf);
      if (!tracks.length) throw new Error("no notes");
      use(f.name.replace(/\.midi?$/i, ""), tracks, pickVocal(tracks), midiBeat(buf));
    } catch {
      setLoaded(null);
      setError("Couldn't read any notes from that file");
    }
  };
  const picking = loaded && source === loaded.name && loaded.tracks.length > 1;
  return (
    <>
      <input
        ref={file}
        type="file"
        accept=".mid,.midi,audio/midi,audio/x-midi"
        hidden
        onChange={(e) => {
          void open(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Chip toggle={false} onClick={() => file.current?.click()} title="Sing a MIDI file's melody: its notes and timing, with your lyrics a syllable a note">
        Import MIDI
      </Chip>
      {picking && (
        <Menu
          label="Sung track"
          value={String(loaded.pick)}
          options={loaded.tracks.map((t, k) => ({ value: String(k), label: `Sing: ${trackName(t, k)} (${t.notes.length})` }))}
          onChange={(v) => use(loaded.name, loaded.tracks, Number(v), loaded.beat)}
        />
      )}
      {loaded && source === loaded.name && (
        <Chip on={legato} onClick={toggleLegato} title="Legato: each note holds until the next one starts, gliding into it, so short piano notes sing as one line (rests over a second stay rests). Switching it re-imports the file, so pitch and timing edits go.">
          Legato
        </Chip>
      )}
      <BackingTracks />
      {error && <span className="midi-error">{error}</span>}
    </>
  );
}

/** The imported file's other tracks, each played on piano under the voice or muted. */
function BackingTracks() {
  const backing = useSing((s) => (s.take?.source ? s.take.backing : undefined));
  const setBackingOn = useSing((s) => s.setBackingOn);
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const toggle = () => {
    const r = box.current?.getBoundingClientRect();
    if (r && backing) {
      const below = innerHeight - r.bottom;
      setUp(below < Math.min(290, backing.length * 28 + 24) && r.top > below);
    }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (!backing?.length) return null;
  const on = backing.filter((b) => b.on).length;
  return (
    <span className="backing" ref={box}>
      <Chip toggle={false} on={on > 0} aria-expanded={open} onClick={toggle} title="The file's other tracks, played on piano under the voice">
        Backing {on}/{backing.length}
      </Chip>
      {open && (
        <div className={up ? "backing-pop up" : "backing-pop"} role="group" aria-label="Backing tracks">
          {backing.map((b, k) => (
            <label key={k}>
              <input type="checkbox" checked={b.on} onChange={(e) => setBackingOn(k, e.target.checked)} />
              <span className="backing-name">{b.name}</span>
              <span className="backing-n">{b.notes.length / 4}</span>
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

/** Sing mode's right column: the song button, the pitch roll, the lyrics, the spectrum with the ring, the song voice, the keys. */
export function SingRight() {
  // the pronouncing dictionary for the lyrics: here rather than on the mode switch, since the app
  // opens on Sing without one
  useEffect(ensureDictionary, []);
  const ring = useStore((s) => s.artic.epilarynx >= RING - 0.05);
  const hasTake = useSing((s) => !!s.take);
  const [drawing, setDrawing] = useState(false);
  const [edit, setEdit] = useState(() => {
    try {
      return localStorage.getItem(ROLL_VIEW) === "edit";
    } catch {
      return false;
    }
  });
  const toggleEdit = () => {
    setEdit(!edit);
    try {
      localStorage.setItem(ROLL_VIEW, edit ? "live" : "edit");
    } catch {
      // not kept: the view still switches
    }
  };
  const editing = edit && (hasTake || drawing);
  return (
    <div className="right right-sing">
      <SingActions />
      <Screen
        className="s-roll"
        title="Pitch"
        sub={editing ? "Drag on the grid to draw, right-click to delete" : ""}
        tools={
          <>
            {editing && <GridTools />}
            <Chip
              on={editing}
              onClick={() => {
                if (hasTake) toggleEdit();
                else {
                  setDrawing(!editing);
                  if (edit === editing) toggleEdit();
                }
              }}
              title="Edit the take as a piano roll: drag on empty grid to draw a note, right-click a note to delete it, drag a note to move it, drag its right end to change its length, hold Ctrl to move everything after it too, hold Alt to move off the grid; middle-drag or Shift+drag to pan, scroll to move through time, Shift+scroll for pitch, Ctrl+scroll to zoom"
            >
              Edit
            </Chip>
          </>
        }
      >
        {editing ? <TakeEditor /> : <PianoRoll />}
      </Screen>
      <Screen className="s-lyrics" title="Lyrics">
        <Lyrics />
      </Screen>
      <Screen className="s-spec" title="Spectrum" sub={ring ? "Ring on" : ""}>
        <SpectrumView ring={ring} />
      </Screen>
      <Screen className="s-voice" title="Voice">
        <SongControls />
      </Screen>
    </div>
  );
}

export function SingKeys() {
  const next = useSing((s) => (s.playing ? null : (s.syllables[s.cursor]?.text ?? null)));
  return (
    <Screen className="s-keys wide-keys" title="Keys" sub={next ? `Next: ${next}` : ""} tools={<MidiButton />}>
      <Keys octaves={4} below={1} />
    </Screen>
  );
}
