(function () {
  'use strict';

  const {
    PLACE_NAMES, CATEGORIES, LISTEN_CATEGORIES, DIGIT_WEIGHTS, randomNumber, toHiragana, toKanji, formatArabic,
    normalize, analyze, parseNumeral, analyzeListening,
  } = JNum;

  const $ = id => document.getElementById(id);
  const els = {
    number: $('number'),
    play: $('play'),
    answer: $('answer'),
    input: $('input'),
    hint: $('hint'),
    status: $('status'),
    previous: $('previous'),
    player: $('player'),
    speed: $('speed'),
    speedValue: $('speed-value'),
    speedControl: $('speed-control'),
    displayToggle: $('display-toggle'),
    credit: $('credit'),
    tallyCorrect: $('tally-correct'),
    tallyTotal: $('tally-total'),
    errorCount: $('error-count'),
    reviewEmpty: $('review-empty'),
    categoryCounts: $('category-counts'),
    missTable: $('miss-table'),
    missRows: $('miss-rows'),
    drillButtons: document.querySelectorAll('[data-drill]'),
    modeButtons: document.querySelectorAll('[data-mode]'),
  };

  // In-memory only: progress resets on every visit.
  const state = {
    drill: 'read',
    mode: 'arabic',
    number: 0,
    attempt: 0,
    locked: false,
    scores: {
      read: { correct: 0, total: 0, errors: [] },
      listen: { correct: 0, total: 0, errors: [] },
    },
  };
  const score = () => state.scores[state.drill];

  // ---- Audio (listen mode) ----

  const audio = {
    clips: null,      // Promise<{ byDigits: {digits: [[n, voice]]} }>, from clips/manifest.json
    current: null,    // { number, voiceId, url: Promise<string>, failed }
    next: null,
    previous: null,
    unlocked: false,
    speed: 1,
  };

  // The clip list: every pre-generated number/voice pair, grouped by digit count.
  function loadClips() {
    audio.clips ??= fetch('clips/manifest.json')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
      .then(manifest => {
        els.credit.textContent = 'Voices: ' + manifest.voices.map(v => `VOICEVOX:${v.name}`).join(', ');
        const byDigits = {};
        for (const [voice, numbers] of Object.entries(manifest.clips)) {
          for (const n of numbers) (byDigits[String(n).length] ??= []).push([n, +voice]);
        }
        return { byDigits };
      });
    audio.clips.catch(() => { audio.clips = null; });
    return audio.clips;
  }

  // Random clip: digit count by DIGIT_WEIGHTS, then any clip of that length.
  function pickClip({ byDigits }) {
    const available = Object.keys(byDigits).filter(d => DIGIT_WEIGHTS[d]);
    let r = Math.random() * available.reduce((sum, d) => sum + DIGIT_WEIGHTS[d], 0);
    const digits = available.find(d => (r -= DIGIT_WEIGHTS[d]) < 0) ?? available[available.length - 1];
    const [n, voice] = byDigits[digits][Math.floor(Math.random() * byDigits[digits].length)];
    return { n, voice };
  }

  // A random clip, or pass a pick ({n, voice}) to reload a specific one.
  function prepareClip(pick) {
    const clip = { number: pick?.n ?? null, voiceId: pick?.voice ?? null };
    const picked = pick ? Promise.resolve(pick) : loadClips().then(pickClip);
    clip.url = picked.then(async p => {
      clip.number = p.n;
      clip.voiceId = p.voice;
      const r = await fetch(`clips/${p.voice}/${p.n}.mp3`);
      if (!r.ok) throw new Error(`clip ${r.status}`);
      return URL.createObjectURL(await r.blob());
    });
    clip.url.catch(() => { clip.failed = true; });
    return clip;
  }

  // Make a clip the current one; the number is known once the clip list has loaded.
  function setCurrent(clip) {
    audio.current = clip;
    state.number = null;
    const settled = () => {
      if (audio.current !== clip) return;
      if (!clip.failed) state.number = clip.number;
      // Fetch the following clip once this one is ready, so they don't compete.
      if (!audio.next) audio.next = prepareClip();
    };
    clip.url.then(settled, settled);
    playClip(clip);
  }

  function releaseClip(clip) {
    clip?.url.then(url => URL.revokeObjectURL(url), () => {});
  }

  // Safari only lets script start audio on an element a user gesture has
  // already played, so play a silent clip on the first key press or click.
  function unlockAudio() {
    if (audio.unlocked) return;
    audio.unlocked = true;
    if (!els.player.paused) return; // already playing, so already allowed
    els.player.src = SILENT_WAV;
    els.player.play().catch(() => { audio.unlocked = false; });
  }

  async function playClip(clip) {
    if (!clip) return;
    els.play.classList.add('is-loading');
    let url;
    try {
      url = await clip.url;
    } catch {
      els.play.classList.remove('is-loading');
      showStatus('Couldn’t load the audio. Check your connection and press R to retry. (Read mode works offline.)');
      return;
    }
    els.play.classList.remove('is-loading');
    hideStatus();
    if (state.drill !== 'listen') return;
    const player = els.player;
    if (player.src !== url) player.src = url;
    player.currentTime = 0;
    player.defaultPlaybackRate = player.playbackRate = audio.speed;
    player.preservesPitch = true;
    try {
      await player.play();
      els.play.classList.remove('is-blocked');
    } catch {
      // Autoplay refused: make the play button the obvious next step.
      els.play.classList.add('is-blocked');
      showStatus('Click 🔊 (or press R) to play.', true);
    }
  }

  function replay() {
    // A clip that failed to load (e.g. server was down) gets a fresh attempt.
    const clip = audio.current;
    if (!clip?.failed) return playClip(clip);
    setCurrent(prepareClip(clip.number != null ? { n: clip.number, voice: clip.voiceId } : undefined));
  }

  function showStatus(text, info = false) {
    els.status.textContent = text;
    els.status.classList.toggle('is-info', info);
    els.status.hidden = false;
  }
  function hideStatus() { els.status.hidden = true; }

  // ---- Drill flow ----

  function newNumber() {
    state.attempt = 0;
    state.locked = false;
    els.answer.hidden = true;
    els.input.value = '';
    els.input.readOnly = false;
    els.input.classList.remove('is-wrong', 'is-correct');

    if (state.drill === 'listen') {
      releaseClip(audio.previous);
      audio.previous = audio.current;
      const next = audio.next || prepareClip();
      audio.next = null;
      setCurrent(next);
      renderPrevious();
    } else {
      state.number = randomNumber();
    }
    renderNumber();
    els.input.focus();
  }

  function renderNumber() {
    if (state.number == null) return;
    const kanji = state.mode === 'kanji';
    els.number.textContent = kanji ? toKanji(state.number) : formatArabic(state.number);
    els.number.classList.toggle('kanji', kanji);
    els.number.lang = kanji ? 'ja' : 'en';
  }

  function renderPrevious() {
    const prev = audio.previous;
    els.previous.hidden = !prev || prev.failed || prev.number == null;
    if (els.previous.hidden) return;
    const reading = el('span', toHiragana(prev.number), 'jp');
    els.previous.replaceChildren('Previous: ', formatArabic(prev.number), ' · ', reading, ' 🔊');
  }

  function renderTally() {
    els.tallyCorrect.textContent = score().correct;
    els.tallyTotal.textContent = score().total;
  }

  function flash(cls) {
    els.input.classList.remove('is-wrong', 'is-correct');
    void els.input.offsetWidth; // restart the animation
    els.input.classList.add(cls);
  }

  function advanceAfter(ms) {
    state.locked = true;
    els.input.readOnly = true;
    setTimeout(newNumber, ms);
  }

  function submit() {
    const listening = state.drill === 'listen';
    const value = els.input.value;
    if (state.locked || state.number == null || !(listening ? value.trim() : normalize(value))) return;
    state.attempt++;
    const result = listening ? analyzeListening(state.number, value) : analyze(state.number, value);

    if (state.attempt === 1) {
      score().total++;
      if (result.correct) score().correct++;
      renderTally();
    }

    if (result.correct) {
      flash('is-correct');
      advanceAfter(450);
      return;
    }

    score().errors.push({ number: state.number, attempt: state.attempt, ...result });
    renderReview();
    flash('is-wrong');

    if (state.attempt >= 3) {
      advanceAfter(900);
      return;
    }
    if (state.attempt === 2) {
      els.answer.textContent = listening
        ? `${formatArabic(state.number)}　${toHiragana(state.number)}`
        : toHiragana(state.number);
      els.answer.hidden = false;
    }
    els.input.select();
  }

  // ---- Review panel ----

  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }

  function readingCell(err, side) {
    const td = el('td', null, 'jp');
    td.lang = 'ja';
    if (!err.segments.length) {
      td.textContent = side === 'given' ? err.given : err.expected;
      return td;
    }
    for (const seg of err.segments) {
      const bad = seg.issues.length > 0;
      let text = seg[side];
      if (!text && bad && side === 'given') text = '＿';
      if (!text) continue;
      td.append(bad ? el('span', text, side === 'given' ? 'seg-bad' : 'seg-fix') : text);
    }
    return td;
  }

  function numeralCell(err, side) {
    const td = el('td');
    if (!err.digits.length) {
      const text = side === 'given' ? err.given : err.expected;
      const n = parseNumeral(text);
      td.append(side === 'given' ? el('span', n ? formatArabic(+n) : text, 'seg-bad') : formatArabic(+text));
    } else {
      err.digits.forEach((d, i) => {
        if (i > 0 && (err.digits.length - i) % 3 === 0) td.append(',');
        td.append(d.bad ? el('span', d[side], side === 'given' ? 'seg-bad' : 'seg-fix') : d[side]);
      });
    }
    if (side === 'expected') td.append(el('br'), el('span', toHiragana(err.number), 'muted jp'));
    return td;
  }

  function errorLabel(err, labels) {
    const text = err.categories.map(c => labels[c]).join(', ');
    if (!err.confusions?.length) return text;
    return text + ' (' + err.confusions.map(c => `${PLACE_NAMES[c.place]}: ${c.expected}→${c.given}`).join(', ') + ')';
  }

  function chip(label, count) {
    const li = el('li', label + ' ');
    li.append(el('b', String(count)));
    return li;
  }

  function renderReview() {
    const listening = state.drill === 'listen';
    const labels = listening ? LISTEN_CATEGORIES : CATEGORIES;
    const errors = score().errors;
    els.errorCount.textContent = errors.length;
    els.reviewEmpty.hidden = errors.length > 0;
    els.missTable.hidden = errors.length === 0;

    const counts = new Map();
    const bump = key => counts.set(key, (counts.get(key) || 0) + 1);
    for (const err of errors) {
      for (const c of err.categories) bump(labels[c]);
      // Which sounds get confused, e.g. "8 heard as 6 (百)".
      for (const c of err.confusions || []) bump(`${c.expected} heard as ${c.given} (${PLACE_NAMES[c.place]})`);
    }
    els.categoryCounts.replaceChildren(
      ...[...counts].sort((a, b) => b[1] - a[1]).map(([label, n]) => chip(label, n))
    );

    els.missRows.replaceChildren(
      ...errors.slice().reverse().map(err => {
        const tr = el('tr');
        const num = el('td');
        num.append(formatArabic(err.number), el('br'), el('span', toKanji(err.number), 'muted'));
        const cell = listening ? numeralCell : readingCell;
        tr.append(num, el('td', String(err.attempt)), cell(err, 'given'), cell(err, 'expected'),
          el('td', errorLabel(err, labels)));
        return tr;
      })
    );
  }

  // ---- Mode switching ----

  function setDrill(drill) {
    if (state.drill === drill) return;
    state.drill = drill;
    const listening = drill === 'listen';
    for (const b of els.drillButtons) b.setAttribute('aria-pressed', String(b.dataset.drill === drill));

    els.number.hidden = listening;
    els.play.hidden = !listening;
    els.displayToggle.hidden = listening;
    els.speedControl.hidden = !listening;
    els.credit.hidden = !listening;
    els.previous.hidden = true;
    hideStatus();

    els.input.lang = listening ? 'en' : 'ja';
    els.input.inputMode = listening ? 'numeric' : 'text';
    els.input.placeholder = listening ? 'Type the number you hear' : 'ひらがなで入力';
    els.input.setAttribute('aria-label', listening ? 'Number you hear' : 'Reading in hiragana');
    els.hint.textContent = listening ? 'Enter to submit · R to replay' : 'Press Enter to submit';

    if (listening) loadClips().catch(() => {});
    else els.player.pause();
    history.replaceState(null, '', listening ? '#listen' : location.pathname + location.search);
    renderTally();
    renderReview();
    newNumber();
  }

  // ---- Events ----

  els.input.addEventListener('keydown', e => {
    unlockAudio();
    if (state.drill === 'listen' && (e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      replay();
      return;
    }
    if (e.key !== 'Enter') return;
    // Ignore the Enter that confirms an IME conversion (keyCode 229 covers Safari).
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  });

  document.addEventListener('pointerdown', unlockAudio, { capture: true });

  els.play.addEventListener('click', () => {
    replay();
    els.input.focus();
  });

  els.previous.addEventListener('click', () => {
    playClip(audio.previous);
    els.input.focus();
  });

  els.speed.addEventListener('input', () => {
    audio.speed = +els.speed.value;
    els.speedValue.textContent = audio.speed.toFixed(2) + '×';
    els.player.defaultPlaybackRate = els.player.playbackRate = audio.speed;
  });

  for (const btn of els.drillButtons) {
    btn.addEventListener('click', () => {
      setDrill(btn.dataset.drill);
      els.input.focus();
    });
  }

  for (const btn of els.modeButtons) {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      for (const b of els.modeButtons) b.setAttribute('aria-pressed', String(b === btn));
      renderNumber();
      els.input.focus();
    });
  }

  // 0.1 s of silence, used to unlock audio playback.
  const SILENT_WAV = (() => {
    const samples = 800, buf = new ArrayBuffer(44 + samples * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  })();

  if (location.hash === '#listen') setDrill('listen');
  else newNumber();
})();
