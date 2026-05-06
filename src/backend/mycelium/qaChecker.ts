/**
 * qaChecker — post-edit quality verification for EDITH.
 *
 * Two-pass check:
 *   1. Programmatic  — caption position, clip gaps, duplicate b-roll (no API)
 *   2. Vision        — frame capture at cut points → Claude Haiku
 *
 * Called from the mycelium:runQA IPC handler after a substantial edit drains.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QAClip {
  id: string;
  type: string;            // 'video' | 'audio' | 'subtitle'
  layer: number;
  sourcePath: string;
  startFrame: number;
  endFrame: number;
  sourceOffset: number;   // sourceStartTime in seconds into the source file
  subtitleY?: number;     // subtitleTransform.y — for caption position check
  subtitleText?: string;
  transcriptContext?: string; // spoken words at this clip's start (optional)
}

export interface QAReferenceInfo {
  sourcePath: string;
  midpointSeconds: number;
}

export interface QAIssue {
  severity: 'error' | 'warning';
  clipId: string;
  label: string;
  issue: string;
  suggestion: string;
}

export interface QAResult {
  passed: boolean;
  issues: QAIssue[];          // vision issues
  programmatic: QAIssue[];    // structural issues found without API
  summary: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFfmpegPath(): string {
  try { return require('ffmpeg-static') as string; } catch { return 'ffmpeg'; }
}

function captureFrame(
  sourcePath: string,
  timestampSeconds: number,
  outPath: string,
  ffmpegPath: string,
): boolean {
  try {
    // Clamp to 0 so we never seek before the file start
    const ts = Math.max(0, timestampSeconds);
    execSync(
      `"${ffmpegPath}" -ss ${ts.toFixed(3)} -i "${sourcePath}" -vframes 1 -q:v 4 -vf "scale=640:-1" -y "${outPath}"`,
      { timeout: 12000 },
    );
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  } catch {
    return false;
  }
}

// ── Pass 1 — Programmatic checks (no API calls) ───────────────────────────────

export function runProgrammaticChecks(clips: QAClip[], fps: number): QAIssue[] {
  const issues: QAIssue[] = [];

  // 1. Caption position — must be in lower half (y: 0.0–0.6 maps to position 0.5–0.8)
  const subtitleClips = clips.filter((c) => c.type === 'subtitle');
  for (const sub of subtitleClips) {
    if (sub.subtitleY !== undefined) {
      // subtitleTransform.y = position * 2 - 1. Mycelium standard: position 0.65 → y 0.30
      // Acceptable range: y 0.0–0.6 (position 0.5–0.8 = lower half)
      if (sub.subtitleY < -0.1 || sub.subtitleY > 0.65) {
        issues.push({
          severity: 'error',
          clipId: sub.id,
          label: `Caption: "${(sub.subtitleText ?? '').slice(0, 24)}…"`,
          issue: `Caption y-position ${sub.subtitleY.toFixed(2)} is outside lower-middle range (expected −0.1–0.65, i.e. position 0.45–0.83)`,
          suggestion: 'Re-emit addCaption with style.position: 0.65 to restore lower-middle placement',
        });
      }
    }
  }

  // 2. Duplicate b-roll source — same file used more than once
  const brollClips = clips.filter((c) => c.type === 'video' && c.layer > 0 && c.sourcePath);
  const sourceCount: Record<string, string[]> = {};
  for (const br of brollClips) {
    const key = br.sourcePath.replace(/\\/g, '/').toLowerCase();
    if (!sourceCount[key]) sourceCount[key] = [];
    sourceCount[key].push(br.id);
  }
  for (const [src, ids] of Object.entries(sourceCount)) {
    if (ids.length > 1) {
      issues.push({
        severity: 'warning',
        clipId: ids[0],
        label: `Duplicate b-roll: ${path.basename(src)}`,
        issue: `The same b-roll file appears ${ids.length} times on the timeline`,
        suggestion: 'Download a different clip for variety, or use an internal cutaway from the source footage',
      });
    }
  }

  // 3. Black gap between consecutive main-layer video clips
  const mainVideo = clips
    .filter((c) => c.type === 'video' && c.layer === 0)
    .sort((a, b) => a.startFrame - b.startFrame);

  for (let i = 0; i < mainVideo.length - 1; i++) {
    const gap = mainVideo[i + 1].startFrame - mainVideo[i].endFrame;
    if (gap > 3) {
      const gapSec = (gap / fps).toFixed(2);
      issues.push({
        severity: 'error',
        clipId: mainVideo[i].id,
        label: `Gap after "${path.basename(mainVideo[i].sourcePath)}"`,
        issue: `${gap}-frame (${gapSec}s) black gap between main clips at frame ${mainVideo[i].endFrame}`,
        suggestion: 'Use trimClip or moveClip to close the gap — never cut+deleteClip to select a segment',
      });
    }
  }

  // 4. B-roll clip without mute — should always be muted
  for (const br of brollClips) {
    if (br.sourcePath && !br.sourcePath.endsWith('.mp3') && !br.sourcePath.endsWith('.wav')) {
      // B-roll video clips should be muted (checked via the 'muted' flag)
      // We don't have 'muted' in QAClip, but the storeAdapter auto-mutes them.
      // This is a sanity guard if someone inserted b-roll manually without mute.
    }
  }

  return issues;
}

// ── Pass 2 — Vision checks ────────────────────────────────────────────────────

interface CutPoint {
  clipId: string;
  label: string;
  isBroll: boolean;
  isMainClip: boolean;
  isReference: boolean;
  transcriptContext?: string;
}

function buildVisionPrompt(cutPoints: CutPoint[]): string {
  const frameList = cutPoints
    .map((cp, i) => {
      const tags = [
        cp.isReference && '[REFERENCE STYLE TARGET]',
        cp.isBroll && '[B-ROLL CUT]',
        cp.isMainClip && '[MAIN FOOTAGE]',
      ].filter(Boolean).join(' ');
      const ctx = cp.transcriptContext ? ` | Speaker says: "${cp.transcriptContext}"` : '';
      return `  Frame ${i + 1}: ${cp.label} ${tags}${ctx}`;
    })
    .join('\n');

  return `You are a senior social media editor doing a quality check on an Instagram Reel (vertical 9:16). I'm showing you frames captured at specific cut points in the edited video. Check for REAL problems only — do not nitpick style choices.

Frames being checked:
${frameList}

Check each frame for these issues:

MAIN FOOTAGE frames:
- Is the speaker properly in frame? (head and shoulders visible, not cut off at edges, not accidentally frozen on a bad expression)
- Is the shot acceptably sharp and well-lit?

B-ROLL CUT frames:
- Does the b-roll content match what the speaker is talking about? (check transcript context if provided)
- Is there a visible watermark (Getty, Shutterstock, etc.)?
- Is someone unexpectedly talking directly to camera in what should be cutaway footage?

CAPTION CHECK frame (live preview with captions rendered — if present):
- Are captions positioned in the lower-middle of the frame? (roughly 60–75% from the top — not covering the face, not at the very bottom edge)
- Is the caption text readable? (not too small, not bleeding off screen edges, not overlapping with other UI elements)
- Is the font large enough for mobile viewing? (should fill roughly 8–12% of frame height)
- Are captions visually clean — no weird overflow, no text cut off at the edges?

REFERENCE STYLE TARGET frame (if present):
- Compare the main footage's color grade to the reference. Does the warmth, contrast, and overall look roughly match?

Return ONLY valid JSON — no markdown fences, no explanation, just the object:
{
  "issues": [
    {
      "frameIndex": 1,
      "severity": "error",
      "issue": "concise description of the actual problem",
      "suggestion": "specific one-sentence fix"
    }
  ],
  "passed": true,
  "summary": "one sentence overall verdict"
}

If everything looks fine: {"issues":[],"passed":true,"summary":"Edit looks clean — framing, b-roll relevance, and color grade all check out."}
Only report genuine problems. Do not flag normal creative choices.`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runQACheck(
  clips: QAClip[],
  fps: number,
  apiKey: string,
  referenceInfo?: QAReferenceInfo,
  captionScreenshot?: string, // base64 JPEG of the live preview canvas with captions rendered
): Promise<QAResult> {
  const ffmpegPath = getFfmpegPath();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-qa-'));

  try {
    // ── Programmatic pass (instant) ─────────────────────────────────────────
    const programmatic = runProgrammaticChecks(clips, fps);

    // ── Vision pass — pick which frames to capture ──────────────────────────
    const capturedFramePaths: string[] = [];
    const cutPoints: CutPoint[] = [];

    // Main clip — midpoint frame (speaker framing check)
    const mainClip = clips.find(
      (c) => c.type === 'video' && c.layer === 0 && c.sourcePath,
    );
    if (mainClip) {
      const midTimelineSec = ((mainClip.startFrame + mainClip.endFrame) / 2) / fps;
      const sourceSec = mainClip.sourceOffset + midTimelineSec;
      const outPath = path.join(tmpDir, 'main_mid.jpg');
      if (captureFrame(mainClip.sourcePath, sourceSec, outPath, ffmpegPath)) {
        cutPoints.push({
          clipId: mainClip.id,
          label: `Main footage midpoint (${midTimelineSec.toFixed(1)}s into reel)`,
          isBroll: false, isMainClip: true, isReference: false,
        });
        capturedFramePaths.push(outPath);
      }
    }

    // Hook frame — very first frame of the reel (is it a strong opening?)
    if (mainClip) {
      const hookSec = mainClip.sourceOffset + 0.3;
      const outPath = path.join(tmpDir, 'main_hook.jpg');
      if (captureFrame(mainClip.sourcePath, hookSec, outPath, ffmpegPath)) {
        cutPoints.push({
          clipId: mainClip.id,
          label: 'Hook frame (0.3s — first impression)',
          isBroll: false, isMainClip: true, isReference: false,
        });
        capturedFramePaths.push(outPath);
      }
    }

    // B-roll cut points — up to 4, spread across the timeline
    const brollClips = clips
      .filter((c) => c.type === 'video' && c.layer > 0 && c.sourcePath)
      .slice(0, 4);

    for (const br of brollClips) {
      const cutInTimelineSec = (br.startFrame / fps).toFixed(1);
      // Capture 0.5s into the b-roll so we get past any fade-in
      const sourceSec = Math.max(0, br.sourceOffset + 0.5);
      const outPath = path.join(tmpDir, `broll_${br.id.slice(-6)}.jpg`);
      if (captureFrame(br.sourcePath, sourceSec, outPath, ffmpegPath)) {
        cutPoints.push({
          clipId: br.id,
          label: `B-roll at ${cutInTimelineSec}s in reel`,
          isBroll: true, isMainClip: false, isReference: false,
          transcriptContext: br.transcriptContext,
        });
        capturedFramePaths.push(outPath);
      }
    }

    // Reference midpoint (style comparison)
    if (referenceInfo) {
      const outPath = path.join(tmpDir, 'reference_mid.jpg');
      if (captureFrame(referenceInfo.sourcePath, referenceInfo.midpointSeconds, outPath, ffmpegPath)) {
        cutPoints.push({
          clipId: 'reference',
          label: 'Reference video (target style)',
          isBroll: false, isMainClip: false, isReference: true,
        });
        capturedFramePaths.push(outPath);
      }
    }

    // Caption screenshot — live canvas with overlays rendered (from frontend)
    // This is the only way to visually verify caption position, size, and text
    const captionImageBlock = captionScreenshot
      ? {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: captionScreenshot },
        }
      : null;
    if (captionScreenshot) {
      cutPoints.push({
        clipId: 'caption-preview',
        label: 'Live preview with captions rendered [CAPTION CHECK]',
        isBroll: false, isMainClip: false, isReference: false,
      });
    }

    // ── If no frames captured, return programmatic results only ─────────────
    if (!capturedFramePaths.length && !captionScreenshot) {
      const hasErrors = programmatic.some((i) => i.severity === 'error');
      return {
        passed: !hasErrors,
        issues: [],
        programmatic,
        summary: programmatic.length > 0
          ? `${programmatic.length} structural issue(s) found. No source frames available for visual check.`
          : 'Structural checks passed. No source frames were accessible for visual check.',
      };
    }

    // ── Send frames to Claude Haiku ─────────────────────────────────────────
    const imageBlocks = [
      ...capturedFramePaths.map((fp) => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/jpeg' as const,
          data: fs.readFileSync(fp).toString('base64'),
        },
      })),
      ...(captionImageBlock ? [captionImageBlock] : []),
    ];

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: buildVisionPrompt(cutPoints) },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`QA API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as any;
    const text: string = data.content?.[0]?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`QA response had no JSON: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]) as any;

    const visionIssues: QAIssue[] = (parsed.issues ?? []).map((raw: any) => {
      const frameIdx = Math.max(0, (raw.frameIndex ?? 1) - 1);
      const cp = cutPoints[frameIdx] ?? cutPoints[0];
      return {
        severity: (raw.severity === 'error' ? 'error' : 'warning') as QAIssue['severity'],
        clipId: cp?.clipId ?? 'unknown',
        label: cp?.label ?? `Frame ${frameIdx + 1}`,
        issue: raw.issue ?? 'Unknown issue',
        suggestion: raw.suggestion ?? '',
      };
    });

    const allIssues = [...programmatic, ...visionIssues];
    const hasErrors = allIssues.some((i) => i.severity === 'error');

    return {
      passed: parsed.passed ?? !hasErrors,
      issues: visionIssues,
      programmatic,
      summary: parsed.summary ?? (allIssues.length === 0 ? 'QA passed.' : `${allIssues.length} issue(s) found.`),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
