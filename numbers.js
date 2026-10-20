// Pure logic for Japanese number readings: generation, kanji, hiragana,
// and classification of wrong answers. Works as a browser global (JNum).
(function (root) {
  'use strict';

  const PLACES = ['man', 'sen', 'hyaku', 'juu', 'ones'];
  const PLACE_VALUES = { man: 10000, sen: 1000, hyaku: 100, juu: 10, ones: 1 };
  const PLACE_KANJI = { man: '万', sen: '千', hyaku: '百', juu: '十', ones: '' };
  const KANJI_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  const STD_DIGIT = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
  const GEM_DIGIT = { 6: 'ろっ', 8: 'はっ' };
  const PLACE_TEXT = {
    man: { plain: 'まん' },
    sen: { plain: 'せん', voiced: 'ぜん' },
    hyaku: { plain: 'ひゃく', voiced: 'びゃく', semi: 'ぴゃく' },
    juu: { plain: 'じゅう' },
    ones: { plain: '' },
  };

  // Every digit spelling the parser understands, correct or not.
  // gem: geminated (small っ) form; variant: non-standard reading;
  // short: missing long vowel; noTsu: geminate form with the っ dropped.
  const DIGIT_FORMS = [
    { text: 'いち', d: 1 },
    { text: 'いっ', d: 1, gem: true },
    { text: 'に', d: 2 },
    { text: 'さん', d: 3 },
    { text: 'よん', d: 4 },
    { text: 'し', d: 4, variant: true },
    { text: 'ご', d: 5 },
    { text: 'ろく', d: 6 },
    { text: 'ろっ', d: 6, gem: true },
    { text: 'ろ', d: 6, gem: true, noTsu: true },
    { text: 'なな', d: 7 },
    { text: 'しち', d: 7, variant: true },
    { text: 'はち', d: 8 },
    { text: 'はっ', d: 8, gem: true },
    { text: 'は', d: 8, gem: true, noTsu: true },
    { text: 'きゅう', d: 9 },
    { text: 'きゅ', d: 9, short: true },
    { text: 'く', d: 9, variant: true },
  ];

  const PLACE_FORMS = {
    man: [{ text: 'まん', voice: 'plain' }],
    sen: [{ text: 'せん', voice: 'plain' }, { text: 'ぜん', voice: 'voiced' }],
    hyaku: [
      { text: 'ひゃく', voice: 'plain' },
      { text: 'びゃく', voice: 'voiced' },
      { text: 'ぴゃく', voice: 'semi' },
    ],
    juu: [{ text: 'じゅう', voice: 'plain' }, { text: 'じゅ', voice: 'plain', short: true }],
    ones: [{ text: '', voice: 'plain' }],
  };

  const CATEGORIES = {
    missedSoundChange: 'Missed sound change',
    wrongSoundChange: 'Wrong sound change',
    missingTsu: 'Missing small っ',
    extraIchi: 'Extra いち',
    missingIchi: 'Missing いち',
    longVowel: 'Long vowel',
    variant: 'Non-standard variant (し / しち / く)',
    wrongDigit: 'Wrong digit',
    missingPlace: 'Missing place',
    extraPlace: 'Extra place',
    unrecognized: 'Unrecognized',
  };

  // Chance of each digit count; longer numbers carry the sound-change exceptions.
  // Keep in sync with DIGIT_WEIGHTS in server.py (which picks clips to pre-generate).
  const DIGIT_WEIGHTS = { 1: 0.05, 2: 0.10, 3: 0.25, 4: 0.30, 5: 0.30 };

  function randomNumber(rng = Math.random) {
    let r = rng(), digits = 5;
    for (const [d, w] of Object.entries(DIGIT_WEIGHTS)) {
      if ((r -= w) < 0) { digits = +d; break; }
    }
    const min = 10 ** (digits - 1);
    return min + Math.floor(rng() * 9 * min);
  }

  function digitsOf(n) {
    const digits = {};
    for (const p of PLACES) digits[p] = Math.floor(n / PLACE_VALUES[p]) % 10;
    return digits;
  }

  // How the correct reading of digit d at a place is formed.
  function expectedShape(d, place) {
    const shape = { implicit: false, gem: false, voice: 'plain' };
    if (d === 1 && (place === 'sen' || place === 'hyaku' || place === 'juu')) shape.implicit = true;
    if (place === 'sen') {
      if (d === 3) shape.voice = 'voiced';
      if (d === 8) shape.gem = true;
    }
    if (place === 'hyaku') {
      if (d === 3) shape.voice = 'voiced';
      if (d === 6 || d === 8) { shape.gem = true; shape.voice = 'semi'; }
    }
    return shape;
  }

  function placeReading(d, place) {
    const s = expectedShape(d, place);
    const prefix = s.implicit ? '' : (s.gem ? GEM_DIGIT[d] : STD_DIGIT[d]);
    return prefix + PLACE_TEXT[place][s.voice];
  }

  function toHiragana(n) {
    const digits = digitsOf(n);
    return PLACES.map(p => (digits[p] ? placeReading(digits[p], p) : '')).join('');
  }

  function toKanji(n) {
    const digits = digitsOf(n);
    return PLACES.map(p => {
      const d = digits[p];
      if (!d) return '';
      const omitOne = d === 1 && p !== 'man' && p !== 'ones';
      return (omitOne ? '' : KANJI_DIGITS[d]) + PLACE_KANJI[p];
    }).join('');
  }

  function formatArabic(n) {
    return n.toLocaleString('en-US');
  }

  // Strip spacing/punctuation and fold katakana to hiragana.
  function normalize(s) {
    return s
      .replace(/[\s　、,・.]/g, '')
      .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  const LEXICON = buildLexicon();

  function buildLexicon() {
    const byPlace = {};
    for (const place of PLACES) {
      const prefixes = place === 'ones'
        ? DIGIT_FORMS.filter(f => !f.gem)
        : [{ text: '', d: 1, implicit: true }, ...DIGIT_FORMS];
      byPlace[place] = [];
      for (const pre of prefixes) {
        for (const pf of PLACE_FORMS[place]) {
          byPlace[place].push({
            text: pre.text + pf.text,
            place,
            d: pre.d,
            implicit: !!pre.implicit,
            gem: !!pre.gem,
            noTsu: !!pre.noTsu,
            voice: pf.voice,
            variant: !!pre.variant,
            short: !!(pre.short || pf.short),
          });
        }
      }
    }
    return byPlace;
  }

  // Issues for one parsed token, given the expected digit e at its place.
  function tokenIssues(tok, e) {
    if (e === 0) return ['extraPlace'];
    if (tok.d !== e) return ['wrongDigit'];
    const exp = expectedShape(e, tok.place);
    const issues = [];
    if (tok.implicit && !exp.implicit) issues.push('missingIchi');
    if (!tok.implicit && exp.implicit) issues.push('extraIchi');
    if (tok.variant) issues.push('variant');
    if (tok.short) issues.push('longVowel');
    if (tok.noTsu) issues.push('missingTsu');
    // Digit 1 never takes a sound change; いっせん etc. is already an extra いち.
    if (tok.d !== 1 && (tok.gem !== exp.gem || tok.voice !== exp.voice)) {
      const expChanged = exp.gem || exp.voice !== 'plain';
      const tokPlain = !tok.gem && tok.voice === 'plain';
      if (!(tok.noTsu && tok.voice === exp.voice)) {
        issues.push(expChanged && tokPlain ? 'missedSoundChange' : 'wrongSoundChange');
      }
    }
    return issues;
  }

  // Compare an answer to the reading of n. Returns
  // { correct, expected, given, segments: [{place, given, expected, issues}], categories }.
  function analyze(n, input) {
    const expected = toHiragana(n);
    const given = normalize(input);
    if (given === expected) {
      return { correct: true, expected, given, segments: [], categories: [] };
    }

    const digits = digitsOf(n);
    const missingSeg = place => ({
      place, given: '', expected: placeReading(digits[place], place), issues: ['missingPlace'],
    });
    const missingBetween = (from, to) => {
      const segs = [];
      for (let i = from; i < to; i++) if (digits[PLACES[i]]) segs.push(missingSeg(PLACES[i]));
      return segs;
    };

    // Lowest-cost parse of given[pos..] using places PLACES[pi..] in order.
    const memo = new Map();
    function best(pos, pi) {
      const key = pos * 8 + pi;
      if (memo.has(key)) return memo.get(key);
      let result = null;
      if (pos === given.length) {
        const segs = missingBetween(pi, PLACES.length);
        result = { cost: segs.length, segs };
      } else {
        for (let qi = pi; qi < PLACES.length; qi++) {
          const skipped = missingBetween(pi, qi);
          for (const tok of LEXICON[PLACES[qi]]) {
            if (!given.startsWith(tok.text, pos)) continue;
            const rest = best(pos + tok.text.length, qi + 1);
            if (!rest) continue;
            const e = digits[tok.place];
            const issues = tokenIssues(tok, e);
            const cost = skipped.length + issues.length + rest.cost;
            if (!result || cost < result.cost) {
              const seg = {
                place: tok.place, given: tok.text,
                expected: e ? placeReading(e, tok.place) : '', issues,
              };
              result = { cost, segs: [...skipped, seg, ...rest.segs] };
            }
          }
        }
      }
      memo.set(key, result);
      return result;
    }

    const parse = given ? best(0, 0) : null;
    const categories = parse ? [...new Set(parse.segs.flatMap(s => s.issues))] : [];
    if (!categories.length) {
      return { correct: false, expected, given, segments: [], categories: ['unrecognized'] };
    }
    return { correct: false, expected, given, segments: parse.segs, categories };
  }

  // ---- Listening mode: compare a typed numeral with the spoken number ----

  const LISTEN_CATEGORIES = {
    wrongDigit: 'Wrong digit',
    missedPlace: 'Missed a place',
    extraPlace: 'Extra place',
    wrongMagnitude: 'Wrong magnitude',
    wrongLength: 'Wrong number of digits',
    unrecognized: 'Not a number',
  };

  const PLACE_NAMES = { man: '万', sen: '千', hyaku: '百', juu: '十', ones: '一' };

  // Digits only, with full-width digits (from an active IME) folded to ASCII.
  function parseNumeral(s) {
    const digits = s
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\s　,，、.]/g, '');
    return /^\d+$/.test(digits) ? digits.replace(/^0+(?=\d)/, '') : null;
  }

  // Returns { correct, expected, given, digits: [{expected, given, bad}],
  //           categories, confusions: [{place, expected, given}] }.
  function analyzeListening(n, input) {
    const expected = String(n);
    const given = parseNumeral(input);
    const result = { correct: false, expected, given: given ?? input, digits: [], categories: [], confusions: [] };
    if (given === null) return { ...result, categories: ['unrecognized'] };
    if (given === expected) return { ...result, correct: true };

    if (given.length !== expected.length) {
      const sameFigures = given.replace(/0+$/, '') === expected.replace(/0+$/, '');
      return { ...result, categories: [sameFigures ? 'wrongMagnitude' : 'wrongLength'] };
    }

    const categories = new Set();
    const firstPlace = PLACES.length - expected.length;
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i], g = given[i], bad = e !== g;
      result.digits.push({ expected: e, given: g, bad });
      if (!bad) continue;
      if (g === '0') categories.add('missedPlace');
      else if (e === '0') categories.add('extraPlace');
      else {
        categories.add('wrongDigit');
        result.confusions.push({ place: PLACES[firstPlace + i], expected: +e, given: +g });
      }
    }
    return { ...result, categories: [...categories] };
  }

  const api = {
    PLACES, PLACE_NAMES, CATEGORIES, LISTEN_CATEGORIES, DIGIT_WEIGHTS, randomNumber, digitsOf, toHiragana, toKanji,
    formatArabic, normalize, analyze, parseNumeral, analyzeListening,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JNum = api;
})(this);
