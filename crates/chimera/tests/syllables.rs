//! Port of tests/syllables.test.ts.
use chimera::phonetics::Segment;
use chimera::phonetics::english::arpabet_to_segments;
use chimera::phonetics::syllables::{lyrics_to_syllables, split_spelling, syllabify_segments};

// a few CMUdict entries, enough to test without loading the dictionary
fn dict(w: &str) -> Option<&'static str> {
    Some(match w {
        "twinkle" => "T W IH1 NG K AH0 L",
        "little" => "L IH1 T AH0 L",
        "star" => "S T AA1 R",
        "how" => "HH AW1",
        "i" => "AY1",
        "wonder" => "W AH1 N D ER0",
        "what" => "W AH1 T",
        "you" => "Y UW1",
        "are" => "AA1 R",
        "extra" => "EH1 K S T R AH0",
        "of" => "AH1 V",
        _ => return None,
    })
}
fn word(w: &str, _reduce: bool) -> Vec<Segment> {
    dict(w).map(arpabet_to_segments).unwrap_or_default()
}
fn ipa(xs: &[Segment]) -> String {
    xs.iter().map(|x| x.ipa.as_str()).collect()
}

#[test]
fn maximal_onset_with_legal_english_clusters() {
    let tw = syllabify_segments(&word("twinkle", false));
    let got: Vec<[String; 3]> = tw.iter().map(|s| [ipa(&s.onset), s.nucleus.ipa.clone(), ipa(&s.coda)]).collect();
    assert_eq!(got, [["tw", "ɪ", "ŋ"].map(String::from), ["k", "ə", "l"].map(String::from)]);
    // "extra": k + str → ek-stra (str is a legal onset)
    let ex = syllabify_segments(&word("extra", false));
    assert_eq!(ex.iter().map(|s| ipa(&s.onset)).collect::<Vec<_>>(), ["", "stɹ"]);
    assert_eq!(ipa(&ex[0].coda), "k");
}

#[test]
fn spelling_splits_to_match() {
    assert_eq!(split_spelling("twinkle", 2), ["twin", "kle"]);
    assert_eq!(split_spelling("little", 2), ["lit", "tle"]);
    assert_eq!(split_spelling("wonder", 2), ["won", "der"]);
    assert_eq!(split_spelling("are", 1), ["are"]);
}

#[test]
fn lyrics_words_melisma_phrase_ends_unreduced_function_words() {
    let syl = lyrics_to_syllables("Twinkle little star, how I - wonder", &word);
    assert_eq!(syl.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), ["Twin", "kle", "lit", "tle", "star", "how", "I", "~", "won", "der"]);
    assert!(syl[4].phrase_end);
    assert_eq!(syl[7].melisma, Some(true));
    assert_eq!(syl[7].nucleus.ipa, "aɪ");
    assert!(syl[1].word_end && !syl[0].word_end);
}

#[test]
fn a_plus_after_a_word_joins_its_syllables_onto_one_note() {
    let syl = lyrics_to_syllables("twinkle+ little star+, wonder", &word);
    let joins: Vec<bool> = syl.iter().map(|s| s.join == Some(true)).collect();
    assert_eq!(joins, [true, false, false, false, false, false, false]);
    assert!(syl[4].phrase_end);
    assert_eq!(syl.len(), 7);
}

/// Each syllable as onset+nucleus+coda IPA, joined with "."; a stop's aspiration, when its front end
/// decides it, as ʰ (aspirated) or ˭ (unaspirated)
fn sung(text: &str) -> String {
    // aspiration with its length when the front end gives one: ʰ45 (45 ms), ʰ90
    let marked = |segs: &[Segment]| {
        segs.iter()
            .map(|s| {
                let asp = match (s.aspirated, s.vot) {
                    (Some(true), Some(v)) => format!("ʰ{}", (v * 1000.0).round()),
                    (Some(true), None) => "ʰ".into(),
                    (Some(false), _) => "˭".into(),
                    (None, _) => String::new(),
                };
                format!("{}{asp}", s.ipa)
            })
            .collect::<String>()
    };
    lyrics_to_syllables(text, &word).iter().map(|s| format!("{}{}{}", marked(&s.onset), s.nucleus.ipa, marked(&s.coda))).collect::<Vec<_>>().join(".")
}

#[test]
fn hangul_sings_one_syllable_per_block_with_korean_sound_rules() {
    assert_eq!(sung("빵야"), "p˭aŋ.ja"); // ㅇ coda stays; tense ㅃ is voiceless and unaspirated
    assert_eq!(sung("먹어"), "mʌ.gʌ"); // a coda moves onto a silent ㅇ, voiced between vowels
    assert_eq!(sung("좋아"), "tɕʰ45o.a"); // ㅎ drops before a vowel; ㅈ is alveolo-palatal
    assert_eq!(sung("좋다"), "tɕʰ45o.tʰ90a"); // ㅎ + ㄷ aspirates
    assert_eq!(sung("국물"), "kʰ45uŋ.mul"); // nasalisation
    assert_eq!(sung("신라"), "ɕil.la"); // ㄴ + ㄹ is [ll]; ㅅ before i is [ɕ]
    assert_eq!(sung("없는"), "ʌm.nɯn"); // a two-letter coda simplifies, then nasalises
    assert_eq!(sung("학교"), "hak.k˭jo"); // tensing after an obstruent coda
    assert_eq!(sung("사랑해"), "sa.ɾaŋ.ɦɛ");
    assert_eq!(sung("닭"), "tʰ45ak");
    assert_eq!(sung("의사"), "ɰi.sa");
    // after a dropped ㅎ the consonant before it moves onto the silent ㅇ
    assert_eq!(sung("싫어"), "ɕi.ɾʌ"); // [시러]
    assert_eq!(sung("많아"), "ma.na"); // [마나]
    assert_eq!(sung("괜찮아"), "kʰ45wɛn.tɕʰ90a.na"); // [괜차나]
    assert_eq!(sung("싫니"), "ɕil.li"); // ㅀ before ㄴ: [실리]
    assert_eq!(sung("않는"), "an.nɯn"); // ㄶ before ㄴ: [안는]
    // ㄷ ㅌ before 이 palatalise
    assert_eq!(sung("같이"), "kʰ45a.tɕʰ90i"); // [가치]
    assert_eq!(sung("굳이"), "kʰ45u.dʑi"); // [구지]
}

#[test]
fn korean_stops_stay_three_ways_apart_word_initially() {
    // word-initially all three are voiceless: aspirated long, lax briefly, tense not at all
    // (불 fire, 풀 grass, 뿔 horn); they used to sing as pul, pul and bul
    assert_eq!(sung("불 풀 뿔"), "pʰ45ul.pʰ90ul.p˭ul");
    assert_eq!(sung("달 탈 딸"), "tʰ45al.tʰ90al.t˭al");
    assert_eq!(sung("가 카 까"), "kʰ45a.kʰ90a.k˭a");
    // inside a word: lax voiced between vowels, the other two as word-initially
    assert_eq!(sung("아기 아키 아끼"), "a.gi.a.kʰ90i.a.k˭i");
}

#[test]
fn lax_and_aspirated_stops_plan_different_aspiration() {
    use chimera::phonetics::planner::{PlanOptions, plan_utterance};
    // how long the folds stay apart after the release: the aspiration gesture's end
    let aspiration_end = |text: &str| {
        let s = &lyrics_to_syllables(text, &word)[0];
        let segs: Vec<Segment> = s.onset.iter().cloned().chain([Segment::new(&s.nucleus.ipa)]).chain(s.coda.iter().cloned()).collect();
        let plan = plan_utterance(&segs, &PlanOptions::default());
        plan.gestures.iter().find(|g| g.label.as_ref().map(|l| l.as_str()) == Some("aspiration")).map(|g| g.t1).unwrap()
    };
    let (lax, aspirated) = (aspiration_end("불"), aspiration_end("풀"));
    // the folds stay apart 45 ms longer for 풀: the difference its front end asked for
    assert!((aspirated - lax - 0.045).abs() < 1e-9, "lax {lax}, aspirated {aspirated}");
}

#[test]
fn text_after_a_letter_no_front_end_reads_is_kept() {
    // accented Latin letters aren't English's: they are skipped, the rest of the word still sings
    // (as before the router). A front end must never swallow what follows.
    let g2p = chimera::phonetics::english::EnglishG2P::new(); // letter-to-sound: reads any word
    let texts: Vec<String> = lyrics_to_syllables("Zürich über", &g2p).into_iter().map(|s| s.text).collect();
    assert!(texts.iter().any(|t| t == "rich") && texts.iter().any(|t| t == "ber"), "{texts:?}");
}

#[test]
fn hangul_keeps_its_spelling_and_mixes_with_english() {
    let syls = lyrics_to_syllables("twinkle 빵야 빵야, star", &word);
    let shown: Vec<(&str, bool, bool)> = syls.iter().map(|s| (s.text.as_str(), s.word_end, s.phrase_end)).collect();
    assert_eq!(
        shown,
        [("twin", false, false), ("kle", true, false), ("빵", false, false), ("야", true, false), ("빵", false, false), ("야", true, true), ("star", true, false)]
    );
}

#[test]
fn hand_written_syllables_may_leave_out_word_and_phrase_ends() {
    let s: chimera::phonetics::Syllable = serde_json::from_str(r#"{"text": "풀", "onset": [{"ipa": "p", "aspirated": true, "vot": 0.09}], "nucleus": {"ipa": "u"}, "coda": [{"ipa": "l"}]}"#).unwrap();
    assert!(!s.word_end && !s.phrase_end);
    assert_eq!(s.onset[0].vot, Some(0.09));
}
