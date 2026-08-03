// Generates the media fixtures the audio-gate / filler-removal tests need,
// locally and on demand — nothing binary lives in the repo.
//   speech-take.mp4     ~23s, SAPI TTS speech that really contains um/uh fillers
//   quarterly-recap.mp4 copy of speech-take under a distinct name (filler e2e)
//   silent-track.mp4    has an audio stream, but pure digital silence
//   no-audio.mp4        video only, no audio stream at all
// Import { ensureFixtures, FIXTURES } from this file; ensureFixtures() is
// idempotent and returns the absolute paths.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES = {
  speech: path.join(DIR, 'speech-take.mp4'),
  quarterly: path.join(DIR, 'quarterly-recap.mp4'),
  silent: path.join(DIR, 'silent-track.mp4'),
  noAudio: path.join(DIR, 'no-audio.mp4'),
};

const SPEECH_TEXT =
  'So um, today I want to talk about, uh, our quarterly numbers. ' +
  'Um, the revenue grew, uh, twelve percent this quarter. ' +
  'And um, I think, uh, we should be really proud of that. ' +
  'Um, next quarter we are, uh, targeting twenty percent.';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr ?? '').slice(-400)}`);
};

export function ensureFixtures() {
  mkdirSync(DIR, { recursive: true });

  if (!existsSync(FIXTURES.speech)) {
    const wav = path.join(DIR, '_speech.wav');
    // Windows SAPI — the only reliable local way to get speech with real "um"/"uh"
    // tokens Whisper will transcribe.
    run('powershell', ['-NoProfile', '-Command', [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      '$s.Rate = -1;',
      `$s.SetOutputToWaveFile('${wav.replace(/\\/g, '\\\\')}');`,
      `$s.Speak('${SPEECH_TEXT}');`,
      '$s.Dispose();',
    ].join(' ')]);
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x1a2b3c:s=640x360:r=30', '-i', wav,
      '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', FIXTURES.speech, '-loglevel', 'error']);
    rmSync(wav, { force: true });
  }

  if (!existsSync(FIXTURES.quarterly)) copyFileSync(FIXTURES.speech, FIXTURES.quarterly);

  if (!existsSync(FIXTURES.silent)) {
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x101010:s=320x180:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', FIXTURES.silent, '-loglevel', 'error']);
  }

  if (!existsSync(FIXTURES.noAudio)) {
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x101010:s=320x180:r=30',
      '-t', '5', '-an', '-c:v', 'libx264', '-preset', 'veryfast', FIXTURES.noAudio, '-loglevel', 'error']);
  }

  return FIXTURES;
}
