# Language front ends

CHIMERA sings other languages in two halves, the usual split in speech synthesis:

```
lyrics ──► router ──► FRONT END ──► syllables ──► BACK END ──► sound
           (by script)  English: CMUdict         (IPA, with what     the planner, the airway,
                        Korean: Hangul rules      the language        the voice: the same for
                        explicit syllables        decides)            every language
```

**A front end is phonology; the back end is physics.** A front end decides what a word's sounds
are: which phonemes, and whether and how long a stop aspirates. The back end realises whatever
the syllables say and knows no language's rules. When a front end says nothing, the planner keeps
English's defaults, which is why English output doesn't change.

This is the shared design for languages (#40), and the first steps of #32 live in it: the sounds
Korean and Mandarin need (`ɕ ʑ tɕ dʑ tʂ dʐ ɥ`, step 3) and aspiration as the front end's call
(step 1, with #73).

## The built-in front ends

| Script | Front end | Needs | Where |
|---|---|---|---|
| Latin | English | CMUdict (letter-to-sound until it loads) | `phonetics/english.rs`, `syllables.rs` |
| Hangul | Korean | nothing: a block's letters are its sounds | `phonetics/korean.rs` |

The router (`read_lyrics` in `syllables.rs`) sends each word to the front end whose script it is
in, so a line can mix them (`twinkle 빵야 star`). It also handles what every language shares:
melisma marks (`-`, `~`), phrase punctuation and word ends.

Characters no front end claims are skipped, as before: `Zürich` sings "Z rich". Nothing after them
is lost.

`chimera syllables "<lyrics>"` prints what the front ends read, one JSON syllable per sung note:
the quickest way to check a front end.

## Korean

One Hangul block is one note, and the block keeps its spelling as the note's text. Inside a word
the front end applies standard Seoul sound rules: a coda moves onto a following silent ㅇ (먹어 →
머거), codas neutralise, obstruents nasalise before nasals (국물 → 궁물), ㄴ and ㄹ meet as [ll],
ㅎ aspirates its neighbour (좋다 → 조타), and obstruents tense after an obstruent coda.

Korean's three stops are all voiceless at the start of a word. The front end tells them apart by
how long they aspirate (`vot`, voice onset time):

| | 불 fire | 풀 grass | 뿔 horn |
|---|---|---|---|
| kind | lax | aspirated | tense |
| written | [pʰ], `vot` 45 ms | [pʰ], `vot` 90 ms | [p˭], unaspirated |
| measured in the render (male; female within 3 ms) | 53 ms | 96 ms | 22 ms |

Between voiced sounds a lax stop is voiced (아기 [agi]). Not modelled yet: the lower pitch that
follows a lax stop (Seoul speakers rely on it as much as on aspiration; it needs pitch contours,
#32 step 4) and the stiff voice of tense stops. A Korean speaker's ear is still wanted.

## The one format

Every front end writes the same thing, one sung syllable per sounding note:

```json
{ "text": "풀", "onset": [{"ipa": "p", "aspirated": true, "vot": 0.09}], "nucleus": {"ipa": "u"},
  "coda": [{"ipa": "l"}], "wordEnd": true, "phraseEnd": false }
```

- `onset` / `coda`: consonants and glides from the inventory (`phonetics/inventory.rs`).
- A stop or affricate may say `"aspirated": true|false` (unsaid: English's rule; `ʰ` and `˭` in
  IPA text) and `"vot"`, its aspiration time in seconds relative to the 50 ms default (unsaid:
  English's 50 ms). Each millisecond more or less than 50 moves the voice's return by a
  millisecond; the measured voice onset also depends on the place and the voice (the Korean table
  above: 45 asked gives 53–69 ms, 90 gives 96–110).
- `nucleus`: one vowel, or a diphthong the planner knows.
- A melisma note is `"melisma": true` with the same nucleus; its coda moves to the run's last note.
- `text` is what the lyrics panel and the piano roll show.
- `wordEnd` and `phraseEnd` may be left out (false).

Any front end's output can be frozen to JSON, edited and sung with `"syllables"` instead of
`"lyrics"`, in `render notes` and duet melody files. Use it to fix a reading
by hand, or to sing a language that has no front end yet.

## Adding a language

1. **Map its sounds onto the inventory.** Add missing ones between their neighbours, as
   `ɕ ʑ tɕ dʑ tʂ dʐ ɥ` were, and let `chimera calibrate consonants` set a fricative's constriction:
   it appends new entries and leaves existing ones alone.
2. **Write the front end**: implement `FrontEnd` (which characters start and continue its words,
   and word → syllables), then add it to the router's list in `lyrics_to_syllables`. A front end
   that needs data should load it like CMUdict: a gzipped file in `public/data/`, fetched only when
   the lyrics need it.
3. **Say the phonology** in the syllables (aspiration and its length). Build `Syllable` and
   `Segment` values with `..Default::default()` so later fields don't break you.
4. **Leave English unchanged.** Tuning the shared voice goes through `docs/hill-climb/README.md`.
5. **Run the scramble test**, below, and **have a native speaker listen.**

## The scramble test

`tools/asr/scramble.py` (set up once with `tools/asr/setup.sh`) measures how intelligible a front
end's singing is on sound alone. A recogniser that knows a lyric fills it in, so it also sings the
same melody with the lyric's units shuffled (syllables for Chinese and Korean, words for English),
leaving nothing to guess from.

- **Material:** public-domain texts: two Tang poems (静夜思, 春晓), the folk song 아리랑, Harvard
  sentences. `--text lang:file` sings your own lines; `tools/asr/probes/` has lines dense in one
  contrast each. Material dense in what a change touches is the only way to see it.
- **Rendering:** through CHIMERA's own front ends (`render notes` with lyrics), one note per
  syllable on one generated tune, a breath between lines, in the male and female voices.
  A language whose script no front end reads yet is skipped.
- **Judge:** SenseVoice-Small (sherpa-onnx), one sung line at a time. It's CTC, so it can't
  hallucinate a loop.
- **Score:** syllable errors (Chinese as toneless pinyin, Korean as Hangul blocks) or word errors
  (English), for the real lyric and the mean over the scrambles.
- **What goes wrong:** each line is aligned with what was heard and the errors split into a
  syllable's parts (Chinese: initial / final / tone; Korean: initial / vowel / final; English:
  phonemes, wrong vs dropped), with the commonest confusions. `--analyze <run>/scramble.json`
  re-reads a run.

On this branch (8 scrambles × 2 voices):

| Language (units) | Real lyric (male / female) | Scrambled (male / female) |
|---|---|---|
| Korean, 아리랑 (syllables) | 30.0 / 15.0% | 52.8 / 55.6% |
| English, Harvard (words) | 48.8 / 53.7% | 68.6 / 75.0% |

The gap between the real and scrambled lyric is what the recogniser fills in from knowing the
text; the scrambled number is the sound. Korean's commonest errors are ㄹ heard as ㄴ or ㄷ and a
coda ㄴ dropped; English's are sounds dropped (a third of vowels and consonants), AH heard as ER,
SH as F and D as T.

Treat about ±2 points as noise at these sizes (8 scrambles × 2 voices) and read the confusion
counts for the sounds a change targets, not just the total. One recogniser and one tune can't stand
in for a native listener; the test says where to look and whether a change moved what it aimed at.

## Not yet

- **Latin-script languages.** Routing by script can't tell Turkish or German from English, so
  Latin text is English. The second Latin-script front end brings an explicit language choice,
  with English the default (#40).
- **Tone and pitch accent** need pitch contours (#32 step 4).
