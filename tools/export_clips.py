"""Convert the VOICEVOX WAV cache into MP3 clips plus a manifest for the static site.

  python3 tools/export_clips.py [CACHE_DIR] [OUT_DIR]   (defaults: cache clips)

Only clips without an MP3 yet are converted, so it can be re-run after
generating more clips. Needs ffmpeg.
"""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# VOICEVOX style ids and the character names the credit line needs.
# Keep in sync with VOICES in docker-compose.yml.
VOICES = {2: '四国めたん', 8: '春日部つむぎ', 11: '玄野武宏', 13: '青山龍星'}
BITRATE = '48k'


def convert(wav, mp3):
    tmp = mp3.with_suffix('.tmp.mp3')
    subprocess.run(
        ['ffmpeg', '-loglevel', 'error', '-y', '-i', str(wav), '-ac', '1',
         '-codec:a', 'libmp3lame', '-b:a', BITRATE, str(tmp)],
        check=True,
    )
    tmp.replace(mp3)


def main():
    root = Path(__file__).resolve().parent.parent
    cache = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'cache'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else root / 'clips'

    clips, todo = {}, []
    for voice in VOICES:
        (out / str(voice)).mkdir(parents=True, exist_ok=True)
        numbers = []
        for wav in (cache / str(voice)).glob('*.wav'):
            if not wav.stem.isdigit() or not 1 <= int(wav.stem) <= 99_999:
                continue
            numbers.append(int(wav.stem))
            mp3 = out / str(voice) / f'{wav.stem}.mp3'
            if not mp3.exists():
                todo.append((wav, mp3))
        clips[str(voice)] = sorted(numbers)

    print(f'{len(todo)} clips to convert', flush=True)
    with ThreadPoolExecutor(os.cpu_count() or 4) as ex:
        for i, _ in enumerate(ex.map(lambda job: convert(*job), todo), 1):
            if i % 1000 == 0:
                print(f'  {i}/{len(todo)}', flush=True)

    manifest = {
        'voices': [{'id': v, 'name': name} for v, name in VOICES.items()],
        'clips': clips,
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
    total = sum(len(c) for c in clips.values())
    print(f'manifest: {total} clips across {len(VOICES)} voices', flush=True)


if __name__ == '__main__':
    main()
