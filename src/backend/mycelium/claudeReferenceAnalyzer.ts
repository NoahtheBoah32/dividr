import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ReferenceAnalysis,
  CaptionStyleAnalysis,
  EditingStyleAnalysis,
  VideoStructureAnalysis,
  ColorGradeAnalysis,
} from './geminiAnalyzer';

function loadAnthropicKey(appPath: string): string {
  const envPath = path.join(appPath, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const [k, v] = line.split('=');
      if (k?.trim() === 'ANTHROPIC_API_KEY') return v?.trim() ?? '';
    }
  }
  return process.env.ANTHROPIC_API_KEY ?? '';
}

function getFfmpegPath(): string {
  try {
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}

function getFfprobePath(): string {
  try {
    const p = require('ffprobe-static');
    return (p as any).path ?? (p as string);
  } catch {
    return 'ffprobe';
  }
}

function getVideoDuration(filePath: string, ffprobePath: string): number {
  const out = execSync(
    `"${ffprobePath}" -v quiet -print_format json -show_streams -show_format "${filePath}"`,
    { encoding: 'utf8', timeout: 10000 },
  );
  const data = JSON.parse(out) as any;
  const stream = data.streams?.find((s: any) => s.codec_type === 'video');
  const dur = parseFloat(stream?.duration ?? '0');
  if (dur > 0) return dur;
  // Fallback: try format duration
  const formatDur = parseFloat(data.format?.duration ?? '0');
  return formatDur;
}

function extractFrame(filePath: string, timestamp: number, outPath: string, ffmpegPath: string): void {
  execSync(
    `"${ffmpegPath}" -ss ${timestamp.toFixed(3)} -i "${filePath}" -vframes 1 -q:v 3 -vf "scale=640:-1" -y "${outPath}"`,
    { timeout: 15000 },
  );
}

const ANALYSIS_PROMPT = `You are a senior social media editor analyzing a reference Reel. I'm showing you frames sampled evenly from this video so an AI editor can recreate its exact style on different footage.

Study the frames carefully: caption styling, color grading, visual structure, and editing energy.

Return ONLY a valid JSON object — no markdown, no explanation, just raw JSON:
{
  "captions": {
    "position": 0.65,
    "fontSize": 90,
    "fontFamily": "Impact",
    "isUppercase": true,
    "isBold": false,
    "fillColor": "#FFFFFF",
    "highlightColor": "#FFD700",
    "highlightPattern": "key-noun",
    "strokeColor": "#000000",
    "strokeWidth": 2,
    "wordsPerPhrase": 3,
    "animationStyle": "word-by-word",
    "shadowEnabled": true,
    "backdropEnabled": false
  },
  "editing": {
    "pacing": "fast",
    "avgClipLengthSeconds": 3.5,
    "hookStyle": "bold-claim",
    "hookDurationSeconds": 3,
    "usesLetterboxBlur": true,
    "usesZoomCuts": false,
    "silenceRemoved": true,
    "musicBed": false,
    "brollStyle": "cutaway"
  },
  "structure": {
    "openingSeconds": 3,
    "bodySeconds": 25,
    "ctaSeconds": 3,
    "totalSeconds": 31
  },
  "colorGrade": {
    "brightness": 1.05,
    "contrast": 1.1,
    "saturation": 1.2,
    "hueRotate": 0,
    "warmth": "warm",
    "look": "cinematic"
  },
  "description": "2-3 sentence summary of the overall style, energy, and editing approach."
}

Field notes:
- captions.position: 0.0=top, 1.0=bottom (0.65 = lower-center, typical Reels)
- captions.fontSize: estimate relative to frame height. Heavy text filling ~10% height ≈ 90. Standard subtitle ≈ 48.
- captions.fontFamily: pick from Impact, Arial Black, Montserrat, Bebas Neue, Inter, Oswald, Roboto. Heavy/condensed → Impact. Rounded/modern → Montserrat or Inter. Tall/narrow → Oswald or Bebas Neue.
- captions.highlightPattern: which word is highlighted — first-word | last-word | key-noun | action-verb | random | none
- colorGrade.brightness/contrast/saturation: multipliers (1.0 = neutral). Estimate from how the footage looks.
- colorGrade.hueRotate: degrees. Warm/orange push → negative. Cool/teal push → positive.
- If no captions are visible in any frame, use sensible defaults (Impact, uppercase, fontSize 90).
- Infer editing pacing from how much visual change there is between frames.
Use exact values you observe. Do not default everything to 1.0.`;

export async function analyzeReferenceVideoWithClaude(
  filePath: string,
  appPath: string,
): Promise<ReferenceAnalysis> {
  const apiKey = loadAnthropicKey(appPath);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in .env');

  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-frames-'));

  try {
    const duration = getVideoDuration(filePath, ffprobePath);
    if (!duration) throw new Error('Could not determine video duration from: ' + filePath);

    const NUM_FRAMES = 8;
    const framePaths: string[] = [];

    for (let i = 0; i < NUM_FRAMES; i++) {
      // Distribute evenly: 0%, 14%, 28%, 42%, 57%, 71%, 85%, 100%
      const t = (duration * i) / (NUM_FRAMES - 1);
      const outPath = path.join(tmpDir, `frame_${i}.jpg`);
      try {
        extractFrame(filePath, t, outPath, ffmpegPath);
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          framePaths.push(outPath);
        }
      } catch {
        // Skip failed frames — we only need a few good ones
      }
    }

    if (!framePaths.length) throw new Error('Failed to extract any frames from video');

    const imageBlocks = framePaths.map((fp) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/jpeg' as const,
        data: fs.readFileSync(fp).toString('base64'),
      },
    }));

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
        messages: [
          {
            role: 'user',
            content: [
              ...imageBlocks,
              { type: 'text', text: ANALYSIS_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as any;
    const text: string = data.content?.[0]?.text ?? '';
    if (!text) throw new Error(`Claude returned empty response: ${JSON.stringify(data)}`);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Claude response contained no JSON: ${text}`);

    const parsed = JSON.parse(jsonMatch[0]) as any;

    const captionStyle: CaptionStyleAnalysis = parsed.captions ?? parsed;
    const editing: EditingStyleAnalysis = parsed.editing ?? {
      pacing: 'medium',
      avgClipLengthSeconds: 3,
      hookStyle: 'none',
      hookDurationSeconds: 3,
      usesLetterboxBlur: false,
      usesZoomCuts: false,
      silenceRemoved: false,
      musicBed: false,
      brollStyle: 'none',
    };
    const structure: VideoStructureAnalysis = parsed.structure ?? {
      openingSeconds: 3,
      bodySeconds: 25,
      ctaSeconds: 3,
      totalSeconds: 31,
    };
    const colorGrade: ColorGradeAnalysis | undefined = parsed.colorGrade;

    return {
      captionStyle,
      editing,
      structure,
      colorGrade,
      description: parsed.description ?? '',
      analyzedAt: Date.now(),
      model: 'claude-haiku-4-5-20251001',
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
