import fs from 'node:fs';
import path from 'node:path';

export interface CaptionStyleAnalysis {
  position: number;
  fontSize: number;
  fontFamily: string;
  isUppercase: boolean;
  isBold: boolean;
  fillColor: string;
  highlightColor?: string;
  highlightPattern?: 'first-word' | 'last-word' | 'key-noun' | 'action-verb' | 'random' | 'none';
  strokeColor?: string;
  strokeWidth?: number;
  wordsPerPhrase: number;
  animationStyle: 'cut' | 'fade' | 'word-by-word' | 'pop';
  shadowEnabled: boolean;
  backdropEnabled: boolean;
}

export interface EditingStyleAnalysis {
  pacing: 'slow' | 'medium' | 'fast';
  avgClipLengthSeconds: number;
  hookStyle: string;
  hookDurationSeconds: number;
  usesLetterboxBlur: boolean;
  usesZoomCuts: boolean;
  silenceRemoved: boolean;
  musicBed: boolean;
  brollStyle: 'cutaway' | 'overlay' | 'none';
}

export interface VideoStructureAnalysis {
  openingSeconds: number;
  bodySeconds: number;
  ctaSeconds: number;
  totalSeconds: number;
}

export interface ColorGradeAnalysis {
  brightness: number;
  contrast: number;
  saturation: number;
  hueRotate: number;
  warmth: 'warm' | 'cool' | 'neutral';
  look: 'cinematic' | 'raw' | 'bright' | 'moody' | 'natural';
}

export interface ReferenceAnalysis {
  captionStyle: CaptionStyleAnalysis;
  editing: EditingStyleAnalysis;
  structure: VideoStructureAnalysis;
  colorGrade?: ColorGradeAnalysis;
  description: string;
  analyzedAt: number;
  model: string;
}

export interface EditSpec {
  segment: {
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    reason: string;
  };
  colorGrade: {
    brightness: number;
    contrast: number;
    saturation: number;
    hueRotate: number;
  };
  captionStyle: CaptionStyleAnalysis;
  letterboxBlur: boolean;
  hookDurationSeconds: number;
  description: string;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
  };
  return map[ext] ?? 'video/mp4';
}

async function uploadToGemini(filePath: string, apiKey: string): Promise<{ uri: string; mimeType: string }> {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const mimeType = getMimeType(filePath);

  // Step 1: initiate resumable upload
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileBuffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: fileName } }),
    },
  );

  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL');

  // Step 2: upload bytes
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Type': mimeType,
    },
    body: fileBuffer,
  });

  const uploadData = (await uploadRes.json()) as any;
  const file = uploadData.file;
  if (!file) throw new Error(`Upload failed: ${JSON.stringify(uploadData)}`);

  // Step 3: poll until ACTIVE
  let fileState: string = file.state;
  let fileUri: string = file.uri;
  const fileResourceName: string = file.name;

  while (fileState === 'PROCESSING') {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileResourceName}?key=${apiKey}`,
    );
    const pollData = (await pollRes.json()) as any;
    fileState = pollData.state;
    fileUri = pollData.uri;
  }

  if (fileState !== 'ACTIVE') throw new Error(`Gemini file processing failed: state=${fileState}`);

  return { uri: fileUri, mimeType };
}

const ANALYSIS_PROMPT = `Watch this entire video carefully from start to finish. You are a senior social media editor analyzing a reference Reel so an AI editor can recreate its exact style on different footage.

Study the captions closely: what font weight and style, how many words per phrase, which word gets the highlight color and WHY (first word? last word? the key noun? the action verb?), where text sits vertically.

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
  "description": "2-3 sentence summary of the overall style, energy, and editing approach an editor should replicate."
}

Field notes:
- captions.position: 0.0=top, 1.0=bottom. 0.65 = lower-center, typical Reels position.
- captions.fontSize: estimate relative to frame height. Large bold text filling ~10% of frame height ≈ 90. Standard subtitle size ≈ 48. Pick a number, don't default to 42.
- captions.fontFamily: pick the closest match from this list only — "Impact", "Arial Black", "Montserrat", "Bebas Neue", "Inter", "Open Sans", "Roboto", "Oswald". If the font is very heavy/condensed with no letter spacing → "Impact". If rounded and modern → "Montserrat" or "Inter". If tall and narrow → "Oswald" or "Bebas Neue".
- captions.isBold: true only if the font looks heavier than normal (not needed for Impact/Bebas Neue which are already heavy by design).
- captions.highlightColor: the color used to make one word pop (yellow, orange, cyan, etc). If no highlight color exists, use "#FFD700".
- captions.highlightPattern: which word is highlighted in each phrase —
    "first-word" = always the first word (e.g. "SO I'm going" → SO highlighted)
    "last-word" = always the last word
    "key-noun" = the main subject/object noun (e.g. "FOR EXAMPLE THEY'RE" → EXAMPLE highlighted)
    "action-verb" = the verb (e.g. "THEY GROW EVERYTHING" → GROW highlighted)
    "random" = no consistent pattern
    "none" = no highlight color used
- captions.wordsPerPhrase: how many words appear on screen at once (2–5 typical).
- animationStyle: cut / fade / word-by-word / pop
- pacing: slow / medium / fast
- hookStyle: bold-claim / question / visual-surprise / none
- brollStyle: cutaway / overlay / none
- colorGrade.brightness: 0.8–1.3 (1.0 = neutral). Estimate from how bright/dark the footage looks.
- colorGrade.contrast: 0.8–1.4 (1.0 = neutral). High contrast = punchy/cinematic.
- colorGrade.saturation: 0.5–1.8 (1.0 = neutral). Vibrant = >1.2, desaturated/muted = <0.9.
- colorGrade.hueRotate: degrees (-30 to 30). Use for obvious color shifts (warm orange push = -10, cool/teal = +10).
Use exact values you observe. Do not default everything to 1.0.`;

export interface SpotCheckItem {
  check: string;
  passed: boolean;
  reason: string;
}

export async function spotCheckImageInline(
  imageBuffer: Buffer,
  imageMime: string,
  prompt: string,
  apiKey: string,
): Promise<SpotCheckItem[]> {
  const base64 = imageBuffer.toString('base64');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: imageMime, data: base64 } },
            { text: prompt },
          ],
        }],
      }),
    },
  );
  const data = (await res.json()) as any;
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error(`Gemini spot-check returned empty response`);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`Gemini spot-check returned no JSON array: ${text}`);
  return JSON.parse(jsonMatch[0]) as SpotCheckItem[];
}

export async function analyzeReferenceVideo(filePath: string, apiKey: string): Promise<ReferenceAnalysis> {
  const { uri, mimeType } = await uploadToGemini(filePath, apiKey);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { mime_type: mimeType, file_uri: uri } },
              { text: ANALYSIS_PROMPT },
            ],
          },
        ],
      }),
    },
  );

  const data = (await res.json()) as any;
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error(`Gemini returned empty response: ${JSON.stringify(data)}`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Gemini response contained no JSON: ${text}`);

  const parsed = JSON.parse(jsonMatch[0]) as any;

  // Support both new nested format and old flat format
  const captionStyle: CaptionStyleAnalysis = parsed.captions ?? parsed;
  const editing: EditingStyleAnalysis = parsed.editing ?? {
    pacing: parsed.pacing ?? 'medium',
    avgClipLengthSeconds: 3,
    hookStyle: parsed.hookStyle ?? 'none',
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

  const colorGrade: ColorGradeAnalysis | undefined = parsed.colorGrade ?? undefined;

  return {
    captionStyle,
    editing,
    structure,
    colorGrade,
    description: parsed.description ?? '',
    analyzedAt: Date.now(),
    model: 'gemini-2.5-flash',
  };
}

export async function generateEditSpec(
  userVideoPath: string,
  referenceVideoPath: string,
  userRequest: string,
  targetDurationSeconds: number,
  apiKey: string,
): Promise<EditSpec> {
  const [userVideo, refVideo] = await Promise.all([
    uploadToGemini(userVideoPath, apiKey),
    uploadToGemini(referenceVideoPath, apiKey),
  ]);

  const prompt = `You are a senior social media video editor for a Filipino permaculture education platform called Mycelium. You are making Instagram Reels that educate and inspire people about indigenous farming and permaculture.

VIDEO 1 (raw interview footage to edit): the first video file
VIDEO 2 (reference Reel — match this style precisely): the second video file

User's request: "${userRequest}"
Target duration: exactly ${targetDurationSeconds} seconds

## Your job

Watch both videos in full. Then choose the BEST ${targetDurationSeconds}-second segment from VIDEO 1, and describe exactly how to replicate the visual style of VIDEO 2.

## Segment selection criteria (in order of priority)

1. **Hook moment** — the segment must open on the most attention-grabbing moment: a surprising fact, a bold claim, a striking visual, or a pattern interrupt. Avoid slow intros.
2. **Educational payoff** — the ${targetDurationSeconds}s should contain a complete thought or technique, not cut mid-sentence.
3. **Visual quality** — prefer segments where the speaker is clearly lit, in-frame, and speaking confidently.
4. **Respect and authenticity** — this content features indigenous elder farmers. Choose segments that honor their knowledge.

## Output format

Return ONLY a valid JSON object — no markdown, no explanation, no code block, just raw JSON:

{
  "segment": {
    "sourceStartSeconds": <number — where to start in VIDEO 1>,
    "sourceEndSeconds": <number — exactly sourceStartSeconds + ${targetDurationSeconds}>,
    "reason": "<1-2 sentences: why this is the best segment and what the hook is>"
  },
  "colorGrade": {
    "brightness": <0.8–1.3, match VIDEO 2>,
    "contrast": <0.8–1.5, match VIDEO 2>,
    "saturation": <0.8–1.6, match VIDEO 2>,
    "hueRotate": <-30–30 degrees, match VIDEO 2's warmth>
  },
  "captionStyle": {
    "position": <0–1, vertical position matching VIDEO 2 captions, 0.65 is lower third>,
    "fontSize": <number — match VIDEO 2 caption size relative to frame. Heavy full-width text ≈ 90. Standard ≈ 48.>,
    "fontFamily": "<pick closest from: Impact, Arial Black, Montserrat, Bebas Neue, Inter, Oswald, Roboto — heavy/condensed → Impact>",
    "isUppercase": <true if VIDEO 2 uses all-caps captions>,
    "isBold": <true only if font looks heavier than normal weight — not needed for Impact/Bebas Neue>,
    "fillColor": "<hex color of caption text in VIDEO 2>",
    "highlightColor": "<hex color used to highlight one word per phrase in VIDEO 2, or '#FFD700' if none>",
    "highlightPattern": "<which word gets highlighted: first-word | last-word | key-noun | action-verb | random | none>",
    "wordsPerPhrase": <2–4, how many words appear on screen at once in VIDEO 2>
  },
  "letterboxBlur": <true if VIDEO 2 shows blurred background bars on a vertical video>,
  "hookDurationSeconds": <how long the opening hook lasts in VIDEO 2>,
  "description": "<2-3 sentences: what makes this segment compelling and how it matches the reference energy>"
}

Critical rules:
- segment.sourceEndSeconds - segment.sourceStartSeconds MUST equal exactly ${targetDurationSeconds}
- Do NOT pick a segment that starts in the middle of a sentence
- colorGrade and captionStyle come exclusively from VIDEO 2 — do not invent them
- If VIDEO 2 has no visible captions, use: fontSize 90, fontFamily "Impact", isUppercase true, isBold false, fillColor "#FFFFFF", highlightColor "#FFD700", highlightPattern "key-noun"`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { file_data: { mime_type: userVideo.mimeType, file_uri: userVideo.uri } },
            { file_data: { mime_type: refVideo.mimeType, file_uri: refVideo.uri } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 8192 },
          temperature: 0.2,
        },
      }),
    },
  );

  const data = (await res.json()) as any;
  // Extract text from response — thinking model may have multiple parts
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
  const text: string = parts.find((p: any) => p.text && !p.thought)?.text
    ?? parts.find((p: any) => p.text)?.text
    ?? '';
  if (!text) throw new Error(`Gemini edit spec returned empty response: ${JSON.stringify(data)}`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Gemini edit spec contained no JSON: ${text}`);

  return JSON.parse(jsonMatch[0]) as EditSpec;
}
