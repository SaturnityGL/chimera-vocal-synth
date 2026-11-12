/**
 * The Song page (the app's front page): pick a tune, type your words, and the head sings them;
 * Video sings it again into a clip to share. The studio (every tab) is `?studio`.
 */
import { useEffect, useRef, useState } from "react";
import { AnatomyView3D } from "./AnatomyView3D.tsx";
import { ActionBar, PrimaryButton } from "./ActionBar.tsx";
import { Segmented } from "./Controls.tsx";
import { Chip, Screen } from "./Screen.tsx";
import { useStore } from "../store.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { g2p } from "../speech.ts";
import { lyricsToSyllables } from "../../wasm/engine.ts";
import { mouthWords } from "../mouthWords.ts";
import { V } from "../colors.ts";
import { nearestBody, presetOf, PRESETS } from "../body.ts";
import { TUNES, type Tune } from "../../song/tunes.ts";
import { fitSong, la } from "../../song/fit.ts";
import { playSong, songWord, stopSong, tickSong, useSong } from "../../song/player.ts";
import { canRecord, Clip } from "../../song/record.ts";
import type { ViewFlags } from "../render/anatomy.ts";
import type { BodyName } from "../../worklet/protocol.ts";

const VIEW: ViewFlags = { pressure: true, particles: true, grid: false, calipers: false };
const DEFAULT_WORDS = "I am a voice made out of air,\ntype me your words and I'll sing them there.";
const SAVED = "chimera-song";

const overlay = mouthWords(songWord, V.green);

interface Saved {
  tune: string;
  words: string;
  voice?: BodyName;
}

function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) ?? "null") as { tune?: unknown; words?: unknown; voice?: unknown } | null;
    if (s && typeof s.tune === "string" && typeof s.words === "string") return { tune: s.tune, words: s.words, voice: typeof s.voice === "string" && s.voice in PRESETS ? (s.voice as BodyName) : undefined };
  } catch {
    // no storage, or not ours: start fresh
  }
  return { tune: TUNES[0].id, words: DEFAULT_WORDS };
}

/** The song as notes for the current body: the words (or "la") fitted to the tune. */
async function prepare(tune: Tune, words: string) {
  await useStore.getState().start();
  if (!useStore.getState().started) return null;
  await g2p.load().catch(() => {}); // letter-to-sound rules without it
  let syls = lyricsToSyllables(words);
  if (!syls.length) syls = lyricsToSyllables(la(tune));
  const body = useStore.getState().body;
  return { notes: fitSong(tune, syls, 12 * tune.octave[nearestBody(body)]), body };
}

export function SongPage() {
  const [saved] = useState(loadSaved);
  const [tuneId, setTuneId] = useState(TUNES.some((t) => t.id === saved.tune) ? saved.tune : TUNES[0].id);
  const [words, setWords] = useState(saved.words);
  const tune = TUNES.find((t) => t.id === tuneId)!;
  const playing = useSong((s) => s.playing);
  const body = useStore((s) => s.body);
  const setBody = useStore((s) => s.setBody);
  const headRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<Clip | null>(null);
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<{ file: File; url: string } | null>(null);
  /** bumped by every start and stop: a start still waiting for the audio then gives up */
  const tokenRef = useRef(0);
  const voice = presetOf(body);

  // the last song's voice comes back with it
  useEffect(() => {
    if (saved.voice && saved.voice !== presetOf(useStore.getState().body)) setBody(PRESETS[saved.voice]);
  }, [saved, setBody]);

  useEffect(() => {
    try {
      localStorage.setItem(SAVED, JSON.stringify({ tune: tuneId, words, voice: voice ?? undefined }));
    } catch {
      // private window: the song just isn't kept
    }
  }, [tuneId, words, voice]);

  useEffect(() => {
    const id = setInterval(tickSong, 50);
    return () => {
      clearInterval(id);
      stop();
    };
  }, []);

  // a new voice starts without the old one's song
  useEffect(() => stop, [body]);

  useEffect(() => () => void (clip && URL.revokeObjectURL(clip.url)), [clip]);

  function stop() {
    tokenRef.current++;
    stopSong();
    clipRef.current?.cancel();
    clipRef.current = null;
    setRecording(false);
  }

  async function play() {
    if (playing || recording) return stop();
    const token = ++tokenRef.current;
    const song = await prepare(tune, words);
    if (song && token === tokenRef.current) playSong(song.notes, tune.bpm, song.body);
  }

  async function video() {
    stop();
    const token = tokenRef.current;
    const song = await prepare(tune, words);
    const canvas = headRef.current?.querySelector("canvas");
    const audio = engine.recordStream();
    if (!song || !canvas || !audio || token !== tokenRef.current) return;
    const rec = new Clip(canvas, audio);
    clipRef.current = rec;
    setRecording(true);
    setClip(null);
    playSong(song.notes, tune.bpm, song.body, () => {
      clipRef.current = null;
      setRecording(false);
      void rec.stop(`chimera-${tune.id}`).then((file) => setClip({ file, url: URL.createObjectURL(file) }));
    });
  }

  const share = clip && typeof navigator.canShare === "function" && navigator.canShare({ files: [clip.file] });

  return (
    <div className="song text-colors">
      <header className="song-top">
        <span className="wordmark">Chimera</span>
        <a className="song-studio" href="?studio">
          Studio
        </a>
      </header>
      <div className="song-head" ref={headRef}>
        <Screen focus label="The head singing your words">
          <AnatomyView3D readouts={false} view={VIEW} overlay={overlay} />
        </Screen>
      </div>
      <div className="song-side">
        <ActionBar label="Song" onSpace={() => void play()}>
          <PrimaryButton label="Play" playing={playing && !recording} busy={recording ? "Recording…" : null} onClick={() => void play()} />
          {canRecord() && (
            <Chip toggle={false} onClick={() => void (recording ? stop() : video())}>
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
        <Screen className="song-words">
          <Segmented<string> label="Tune" value={tuneId} onChange={setTuneId} options={TUNES.map((t) => ({ value: t.id, label: t.name }))} />
          <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={3} maxLength={600} aria-label="Your words" placeholder="Your words" />
          <Segmented<BodyName>
            label="Voice"
            value={voice}
            onChange={(b) => setBody(PRESETS[b])}
            options={[
              { value: "male", label: "Male" },
              { value: "female", label: "Female" },
              { value: "child", label: "Child" },
            ]}
          />
        </Screen>
      </div>
    </div>
  );
}
