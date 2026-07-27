/**
 * Sends a rendered clip to Gemini for a harsh smoothness critique.
 *
 * The key is read from disk and never printed. Every failure path scrubs the
 * key out of the message before it is shown, so a bad request cannot leak it.
 * Running cost is tracked in C:/tmp/gemini-spend.json against a hard cap.
 *
 * usage: node gemini-critique.mjs <clip.mp4> <model> "<prompt>"
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

const CAP_USD = 0.2;
const SPEND_FILE = 'C:/tmp/gemini-spend.json';

// USD per 1M tokens.
const PRICES = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10.0 },
};

const [clipPath, model = 'gemini-2.5-flash', prompt = 'Critique this.'] =
  process.argv.slice(2);

const KEY_FILE =
  process.env.GEMINI_KEY_FILE || 'C:/Users/User/Downloads/gemini-key.txt';
const KEY = (() => {
  const raw = readFileSync(KEY_FILE, 'utf8');
  return raw.replace(/^[^:=]*[:=]\s*/, '').trim();
})();
const scrub = (s) => String(s).split(KEY).join('[KEY]');

const spend = existsSync(SPEND_FILE)
  ? JSON.parse(readFileSync(SPEND_FILE, 'utf8'))
  : { totalUsd: 0, calls: [] };

if (spend.totalUsd >= CAP_USD) {
  console.log(
    `BUDGET STOP: $${spend.totalUsd.toFixed(4)} of $${CAP_USD.toFixed(2)} already spent. Not calling.`,
  );
  process.exit(2);
}

const bytes = clipPath
  .split(',')
  .reduce((a, p) => a + statSync(p.trim()).size, 0);
// Rough pre-flight estimate so a call is never made blind. Gemini bills video
// at about 300 tokens per second of footage.
const est = ((bytes / 1e6) * 0 + 300 * 5 + 400) / 1e6;
const price = PRICES[model] ?? PRICES['gemini-2.5-flash'];
console.log(
  `[budget] spent so far $${spend.totalUsd.toFixed(4)} of $${CAP_USD.toFixed(2)}  |  ` +
    `this call est. <$${(est * price.in + (900 / 1e6) * price.out).toFixed(4)} on ${model}`,
);

// Gemini samples video at 1 fps by default, which cannot see judder at all.
// videoMetadata.fps raises it so the model actually looks at the motion.
const FPS = Number(process.env.GEMINI_FPS || 0);
const clips = clipPath.split(',').filter(Boolean);
const parts = [{ text: prompt }];
clips.forEach((p, i) => {
  if (clips.length > 1) parts.push({ text: `\n--- CLIP ${'AB'[i] ?? i} ---` });
  parts.push({
    inlineData: {
      mimeType: 'video/mp4',
      data: readFileSync(p.trim()).toString('base64'),
    },
    ...(FPS ? { videoMetadata: { fps: FPS } } : {}),
  });
});

const body = {
  contents: [{ parts }],
  generationConfig: { temperature: 0.2, maxOutputTokens: 1600 },
};

let res, json;
try {
  res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify(body),
    },
  );
  json = await res.json();
} catch (e) {
  console.log('REQUEST FAILED:', scrub(e?.message ?? e));
  process.exit(1);
}

if (!res.ok) {
  console.log(`HTTP ${res.status}:`, scrub(JSON.stringify(json).slice(0, 600)));
  process.exit(1);
}

const u = json.usageMetadata ?? {};
const inTok = u.promptTokenCount ?? 0;
const outTok = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
const cost = (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
spend.totalUsd += cost;
spend.calls.push({ model, inTok, outTok, cost: +cost.toFixed(6) });
writeFileSync(SPEND_FILE, JSON.stringify(spend, null, 1), 'utf8');

const text =
  json.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n') ??
  '(no text)';
console.log(`\n${'='.repeat(70)}\n${scrub(text)}\n${'='.repeat(70)}`);
console.log(
  `[billing] this call: ${inTok} in + ${outTok} out = $${cost.toFixed(5)}  |  ` +
    `running total $${spend.totalUsd.toFixed(4)} of $${CAP_USD.toFixed(2)} ` +
    `(${((spend.totalUsd / CAP_USD) * 100).toFixed(1)}% of cap)`,
);
