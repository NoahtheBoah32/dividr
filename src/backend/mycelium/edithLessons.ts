/**
 * edithLessons — persistent self-correction memory for EDITH.
 *
 * When QA catches an issue and EDITH's correction turn resolves it,
 * the mistake + fix gets recorded here. Lessons are injected into
 * EDITH's system prompt on every future session so she doesn't repeat them.
 */

import fs from 'node:fs';
import path from 'node:path';

export type LessonCategory =
  | 'caption'    // position, color, style, timing
  | 'broll'      // relevance, watermark, duplicate, talking-head
  | 'framing'    // speaker crop, bad freeze frame
  | 'color'      // grade mismatch, user-specified color overridden
  | 'timing'     // gap, overlap, sourceOffset error
  | 'other';

export interface EdithLesson {
  date: string;           // ISO date string
  category: LessonCategory;
  userRequest: string;    // what the user originally asked for (trimmed to 120 chars)
  mistake: string;        // what QA found wrong (one sentence)
  fix: string;            // what corrective op resolved it (one sentence)
}

const MAX_LESSONS = 60;
const INJECT_COUNT = 15; // how many to include in the prompt

function getLessonsPath(appDataPath: string): string {
  const dir = path.join(appDataPath, 'edith-history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'lessons.json');
}

export function loadLessons(appDataPath: string): EdithLesson[] {
  const p = getLessonsPath(appDataPath);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as EdithLesson[];
  } catch {
    return [];
  }
}

export function addLesson(appDataPath: string, lesson: EdithLesson): void {
  const existing = loadLessons(appDataPath);

  // Deduplicate — skip if same mistake was already recorded recently
  const isDuplicate = existing.slice(-10).some(
    (l) => l.category === lesson.category && l.mistake.slice(0, 60) === lesson.mistake.slice(0, 60),
  );
  if (isDuplicate) return;

  const updated = [...existing, lesson].slice(-MAX_LESSONS);
  try {
    fs.writeFileSync(getLessonsPath(appDataPath), JSON.stringify(updated, null, 2));
  } catch (e) {
    console.error('[edithLessons] failed to save:', e);
  }
}

export function formatLessonsForPrompt(lessons: EdithLesson[]): string {
  if (!lessons.length) return '';
  const recent = lessons.slice(-INJECT_COUNT);
  const lines = recent.map(
    (l) => `[${l.date.slice(0, 10)} | ${l.category}] User asked: "${l.userRequest}" — Mistake: ${l.mistake} — Fix: ${l.fix}`,
  );
  return `\n\n## Lessons from past self-corrections\nThese are real mistakes you made and then fixed via QA. Do not repeat them.\n\n${lines.join('\n')}`;
}

// Infer lesson category from QA issue text
export function inferCategory(issueText: string): LessonCategory {
  const t = issueText.toLowerCase();
  if (t.includes('caption') || t.includes('subtitle') || t.includes('text') || t.includes('font') || t.includes('color') || t.includes('position')) return 'caption';
  if (t.includes('b-roll') || t.includes('broll') || t.includes('watermark') || t.includes('stock') || t.includes('talking') || t.includes('duplicate')) return 'broll';
  if (t.includes('frame') || t.includes('crop') || t.includes('cut off') || t.includes('speaker')) return 'framing';
  if (t.includes('grade') || t.includes('brightness') || t.includes('saturation') || t.includes('warm') || t.includes('color grade')) return 'color';
  if (t.includes('gap') || t.includes('overlap') || t.includes('offset') || t.includes('timing') || t.includes('black')) return 'timing';
  return 'other';
}
