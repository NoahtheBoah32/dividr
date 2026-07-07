import { describe, it, expect } from 'vitest';
import {
  parseAsteriskTriggers,
  resolveSfxName,
  isValidSfxWord,
  normalizeSfxKey,
  sfxOpForWord,
  SFX_TIMELINE_GREEN,
} from './sfxTriggerUtils';

// The real DIVIDR_SFX_LIBRARY — all 41 files.
const LIB = [
  'airport_ding', 'applause_clap', 'bass_drop', 'bell', 'boom_impact', 'bubble_pop',
  'camera_shutter', 'cash_register', 'click', 'coins', 'correct_ding', 'crickets',
  'ding_notification', 'drum_roll', 'error_buzzer', 'explosion', 'footsteps', 'game_over',
  'glass_break', 'heartbeat', 'keyboard_typing', 'laugh_track', 'level_up_chime',
  'magic_transition', 'notification_pop', 'page_turn', 'pop', 'punch_whack',
  'record_scratch', 'rewind', 'riser', 'sad_trombone', 'slot_machine_win',
  'sparkle_twinkle', 'suspense_sting', 'swoosh_in', 'swoosh_out', 'typewriter',
  'vine_boom', 'whoosh_transition', 'wrong_answer_buzz',
].map((s) => `${s}.mp3`);

describe('sfx asterisk trigger — parsing', () => {
  it('only matches a COMPLETE *word*', () => {
    expect(parseAsteriskTriggers('*whoosh*').map((t) => t.word)).toEqual(['whoosh']);
    expect(parseAsteriskTriggers('*whoosh')).toEqual([]); // unclosed → nothing
    expect(parseAsteriskTriggers('whoosh*')).toEqual([]); // no opening
    expect(parseAsteriskTriggers('**')).toEqual([]); // empty
    expect(parseAsteriskTriggers('a * b')).toEqual([]); // lone asterisk
  });

  it('finds multiple markers inline with correct positions', () => {
    const t = parseAsteriskTriggers('and then *boom* he left *pop*');
    expect(t.map((x) => x.word)).toEqual(['boom', 'pop']);
    expect(t[0].raw).toBe('*boom*');
    expect('and then *boom* he left *pop*'.slice(t[1].start, t[1].end)).toBe('*pop*');
  });

  it('trims inner whitespace but keeps multi-word phrases', () => {
    expect(parseAsteriskTriggers('*  whoosh transition  *').map((t) => t.word)).toEqual([
      'whoosh transition',
    ]);
  });
});

describe('sfx asterisk trigger — resolution (every SFX)', () => {
  it('EVERY library SFX resolves from its own stem, uniquely to itself', () => {
    for (const filename of LIB) {
      const stem = filename.replace('.mp3', '');
      expect(resolveSfxName(stem, LIB), `*${stem}* should resolve`).toBe(filename);
      // also the spaced form a user might type
      expect(resolveSfxName(stem.replace(/_/g, ' '), LIB)).toBe(filename);
    }
  });

  it('friendly single words resolve to the sensible SFX', () => {
    const cases: Record<string, string> = {
      whoosh: 'whoosh_transition.mp3',
      boom: 'boom_impact.mp3', // token-first beats vine_boom
      ding: 'ding_notification.mp3', // first-token beats airport_ding / correct_ding
      pop: 'pop.mp3', // exact stem beats bubble_pop / notification_pop
      click: 'click.mp3',
      bell: 'bell.mp3',
      laugh: 'laugh_track.mp3',
      applause: 'applause_clap.mp3',
      clap: 'applause_clap.mp3',
      scratch: 'record_scratch.mp3',
      punch: 'punch_whack.mp3',
      explosion: 'explosion.mp3',
      sparkle: 'sparkle_twinkle.mp3',
      coins: 'coins.mp3',
      heartbeat: 'heartbeat.mp3',
      typewriter: 'typewriter.mp3',
      rewind: 'rewind.mp3',
      crickets: 'crickets.mp3',
      footsteps: 'footsteps.mp3',
      riser: 'riser.mp3',
    };
    for (const [word, expected] of Object.entries(cases)) {
      expect(resolveSfxName(word, LIB), `*${word}*`).toBe(expected);
    }
  });

  it('aliases resolve non-token synonyms', () => {
    expect(resolveSfxName('slide', LIB)).toBe('swoosh_in.mp3');
    expect(resolveSfxName('explode', LIB)).toBe('explosion.mp3');
    expect(resolveSfxName('kaching', LIB)).toBe('cash_register.mp3');
    expect(resolveSfxName('cha-ching', LIB)).toBe('cash_register.mp3');
    expect(resolveSfxName('womp', LIB)).toBe('sad_trombone.mp3');
    expect(resolveSfxName('keyboard', LIB)).toBe('keyboard_typing.mp3');
  });

  it('is case- and separator-insensitive', () => {
    expect(resolveSfxName('WHOOSH', LIB)).toBe('whoosh_transition.mp3');
    expect(resolveSfxName('Vine-Boom', LIB)).toBe('vine_boom.mp3');
    expect(resolveSfxName('game over', LIB)).toBe('game_over.mp3');
  });

  it('unknown words never trigger (the *divebomb* rule)', () => {
    for (const bad of ['divebomb', 'xyz', 'airhorn', 'teleport', 'zzz', '', '123abcxyz']) {
      expect(resolveSfxName(bad, LIB), `*${bad}* must NOT trigger`).toBeNull();
      expect(isValidSfxWord(bad, LIB)).toBe(false);
    }
  });

  it('normalizeSfxKey strips separators and case', () => {
    expect(normalizeSfxKey('Whoosh_Transition')).toBe('whooshtransition');
    expect(normalizeSfxKey('cha-ching!')).toBe('chaching');
  });
});

describe('sfx asterisk trigger — op building (every SFX places correctly)', () => {
  const fps = 30;

  it('EVERY SFX builds a green placeSFX op at the exact frame', () => {
    for (const filename of LIB) {
      const stem = filename.replace('.mp3', '');
      const atFrame = 123; // any timeline frame
      const op = sfxOpForWord(stem, atFrame, fps, LIB);
      expect(op, `*${stem}* should build an op`).not.toBeNull();
      expect(op!.type).toBe('placeSFX');
      expect(op!.file).toBe(filename); // the right SFX
      expect(op!.color).toBe(SFX_TIMELINE_GREEN); // green on the timeline
      // atTime * fps must round back to the exact frame the marker sat on
      expect(Math.round(op!.atTime * fps)).toBe(atFrame);
      expect(op!.volume).toBeLessThan(0);
      expect(op!.trackName).toBe(stem);
    }
  });

  it('places at frame 0 when the marker is at the very start', () => {
    const op = sfxOpForWord('boom', 0, fps, LIB);
    expect(op!.atTime).toBe(0);
    expect(Math.round(op!.atTime * fps)).toBe(0);
  });

  it('never builds an op for an unknown word', () => {
    for (const bad of ['divebomb', 'nope', 'teleport', '']) {
      expect(sfxOpForWord(bad, 90, fps, LIB), `*${bad}*`).toBeNull();
    }
  });

  it('friendly words build ops for the right SFX', () => {
    expect(sfxOpForWord('whoosh', 60, fps, LIB)!.file).toBe('whoosh_transition.mp3');
    expect(sfxOpForWord('slide', 60, fps, LIB)!.file).toBe('swoosh_in.mp3');
    expect(sfxOpForWord('ding', 60, fps, LIB)!.file).toBe('ding_notification.mp3');
  });
});
