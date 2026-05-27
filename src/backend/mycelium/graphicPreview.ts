/**
 * graphicPreview — pre-render screenshot and design review for Hyperframes graphics.
 *
 * Renders HTML in an offscreen Electron BrowserWindow (no extra Chrome download),
 * captures a PNG at the correct canvas dimensions, sends to Claude Haiku for
 * design review. If the design fails, the issues are returned to FridayPanel
 * which auto-continues EDITH with a critique so she can revise before the
 * full Hyperframes render.
 */

import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GraphicReview {
  passed: boolean;
  issues: string[];
  summary: string;
}

// Inject a cinematic fake background behind the HTML for the screenshot.
// backdrop-filter: blur() has nothing to blur when body is transparent — this gives it
// a rich warm background so the glass effect renders exactly as it will over real video footage.
function injectPreviewBackground(html: string): string {
  const fakeBg = `<style>
    html::before {
      content: '';
      position: fixed; inset: 0; z-index: -9999;
      background:
        radial-gradient(ellipse 90% 70% at 40% 35%, rgba(210,120,40,0.55) 0%, transparent 55%),
        radial-gradient(ellipse 60% 40% at 75% 70%, rgba(80,40,140,0.35) 0%, transparent 50%),
        linear-gradient(160deg, #1a1008 0%, #0d0d14 55%, #080812 100%);
    }
  </style>`;
  // Insert just before </head> — if no head tag, prepend
  return html.includes('</head>')
    ? html.replace('</head>', `${fakeBg}</head>`)
    : fakeBg + html;
}

// Render HTML in a hidden offscreen Electron window and return a PNG buffer.
export async function screenshotHtml(
  html: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const previewHtml = injectPreviewBackground(html);
  const tmpPath = path.join(os.tmpdir(), `edith-preview-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, previewHtml, 'utf8');

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        offscreen: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const cleanup = () => {
      try { win.close(); } catch {}
      try { fs.unlinkSync(tmpPath); } catch {}
    };

    win.loadFile(tmpPath);

    win.webContents.on('did-finish-load', () => {
      // Give GSAP and CSS animations 1.2s to initialise before capturing
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
          cleanup();
          resolve(image.toPNG());
        } catch (e) {
          cleanup();
          reject(e);
        }
      }, 1200);
    });

    win.webContents.on('did-fail-load', (_e, _code, desc) => {
      cleanup();
      reject(new Error(`Graphic preview load failed: ${desc}`));
    });

    // Safety timeout — never hang for more than 20s
    setTimeout(() => {
      cleanup();
      reject(new Error('Graphic preview timed out after 20s'));
    }, 20000);
  });
}

// Send the screenshot PNG to Claude Haiku for a design quality review.
export async function reviewGraphicDesign(
  pngBase64: string,
  apiKey: string,
): Promise<GraphicReview> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
          },
          {
            type: 'text',
            text: `You are a senior motion graphics designer reviewing a 9:16 social media graphic overlay (1080×1920px). This will sit transparently on top of video footage on an Instagram Reel.

Check for these problems:
- Is the layout visually structured and intentional, or does it look like raw unstyled HTML?
- Does it have proper visual hierarchy (background blur/glass layer, mid text, accent)?
- Is it using a real design language (glassmorphism, neon, cinematic titles, etc.) — not plain colored boxes with text?
- Is text legible with contrast treatment (shadow, glow, or contrasting background)?
- Are any elements clipped, overflowing, or outside the visible area?
- Does it look polished enough for a professional social media post?

Return ONLY valid JSON:
{"passed":true,"issues":[],"summary":"one sentence verdict"}

Set passed=false if it looks generic/unstyled/broken. List issues as specific CSS/design action items, e.g.:
- "Container has no backdrop-filter or blur — add glassmorphism layer"
- "Text has no shadow or contrast — unreadable over video"
- "All elements same size — no visual hierarchy"
- "White background visible — should be transparent or use rgba"

Only flag real problems. Do not nitpick intentional style choices.`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`Design review API error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  const text: string = data.content?.[0]?.text ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { passed: true, issues: [], summary: 'Design review unavailable' };

  try {
    return JSON.parse(match[0]) as GraphicReview;
  } catch {
    return { passed: true, issues: [], summary: 'Design review parse failed' };
  }
}
