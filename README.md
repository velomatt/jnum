# jnum

A small drill for reading and hearing Japanese numbers, with extra attention to the sound changes that trip people up: 300 (さんびゃく), 600 (ろっぴゃく), 800 (はっぴゃく), 3,000 (さんぜん) and 8,000 (はっせん).

**Try it:** https://velomatt.github.io/jnum/

## Features

**Read mode.** A random number from 1 to 99,999 is shown, either as numerals (38,300) or in kanji (三万八千三百). Type its reading in hiragana and press Enter.

**Listen mode.** A number is read aloud by one of four voices. Type what you hear as digits. Press R (or the speaker button) to replay, and use the speed slider (0.5× to 1.5×) to slow it down or push it faster.

In both modes:

- A wrong answer gets a second try. After the second miss the correct answer is shown; the third Enter moves on.
- The tally counts first-try answers only.
- Every mistake is logged in the Review panel and sorted into a category, so you can see what you keep getting wrong. For example:
  - missed sound change (さんひゃく instead of さんびゃく)
  - an extra いち (いちひゃく instead of ひゃく)
  - a dropped long vowel (きゅ instead of きゅう)
  - which digits you confuse when listening ("8 heard as 6" in the hundreds)
- Shorter numbers come up too, but most have three to five digits, since that's where the tricky readings live.
- Nothing is saved: progress resets when you reload the page.

Typing with a Japanese IME works as expected: the Enter that confirms a conversion doesn't submit your answer.

## How it works

The site is plain HTML, CSS and JavaScript with no build step, hosted on GitHub Pages.

The listening audio was generated ahead of time with [VOICEVOX](https://voicevox.hiroshiba.jp/), a free Japanese text-to-speech engine, and is stored as MP3 files in `clips/`. The page picks clips from `clips/manifest.json`, so no server is needed. Every reading was checked against the app's own reading rules before publishing.

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The page and its behavior |
| `numbers.js` | Readings, kanji, and answer checking |
| `test.html` | Tests for `numbers.js`; open it in a browser |
| `tools/export_clips.py` | Converts generated audio to MP3 and writes the manifest |
| `server.py`, `docker-compose.yml` | Generates new clips with VOICEVOX in Docker |

## Running it locally

Any static file server works:

```
python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Generating more clips

Needs Docker and ffmpeg.

1. Start the VOICEVOX engine and the clip generator, raising `STOCK_CAP` above the current clip count:
   ```
   STOCK_CAP=30000 VV_THREADS=16 docker compose up -d
   ```
   Clips are written to `cache/`. Watch progress with `docker compose logs app`.
2. Convert them for the site:
   ```
   python3 tools/export_clips.py
   ```
3. Commit and push `clips/`.

## Credits

Voices: VOICEVOX:四国めたん, VOICEVOX:春日部つむぎ, VOICEVOX:玄野武宏, VOICEVOX:青山龍星.
