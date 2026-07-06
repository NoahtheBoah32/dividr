// REALISTIC scenario: markers detected WITHIN the clip window,
// then clip is trimmed

const fps = 30;

// Realistic: 10-second video (300 frames) with scene cuts detected inside it
// Markers at: 2s, 5s, 7s (these are ACTUAL source times, within [0, 10] range)

console.log("=== SCENARIO: Realistic Scene Markers ===\n");

let sourceStartTime = 0;
let startFrame = 0;
let endFrame = 300;  // 10 seconds
let duration = (endFrame - startFrame) / fps;

// Scene cuts DETECTED at these source times
const markers = [
  { atSeconds: 2 },
  { atSeconds: 5 },
  { atSeconds: 7 }
];

console.log("BEFORE TRIM:");
console.log(`  sourceStartTime: ${sourceStartTime}s`);
console.log(`  clip shows source [${sourceStartTime}s, ${sourceStartTime + duration}s]`);
console.log(`  markers: ${markers.map(m => m.atSeconds).join(', ')}s`);

const fracBefore = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac: frac.toFixed(3), visible };
});
console.log(`  fractions after render: ${JSON.stringify(fracBefore)}`);
console.log(`  result: ${fracBefore.filter(f => f.visible).length} visible markers\n`);

// NOW: User trims RIGHT edge from 300 to 150 frames (shrinks 10s -> 5s)
// This reduces the clip's visible window but sourceStartTime stays 0
console.log("AFTER RIGHT TRIM (300->150 frames, i.e., 10s->5s):");
endFrame = 150;
duration = (endFrame - startFrame) / fps;

console.log(`  sourceStartTime: ${sourceStartTime}s (unchanged)`);
console.log(`  clip now shows source [${sourceStartTime}s, ${sourceStartTime + duration}s]`);
console.log(`  sceneMarkers still contains: ${markers.map(m => m.atSeconds).join(', ')}s`);

const fracAfter = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac: frac.toFixed(3), visible };
});
console.log(`  fractions after render: ${JSON.stringify(fracAfter)}`);
console.log(`  result: ${fracAfter.filter(f => f.visible).length} visible markers`);
console.log(`  BUG: All markers disappeared! They should still be visible within [0, 5s]!\n`);

// LEFT TRIM scenario
console.log("---\n");
console.log("LEFT TRIM SCENARIO:");
sourceStartTime = 0;
startFrame = 0;
endFrame = 300;
duration = (endFrame - startFrame) / fps;

console.log("BEFORE TRIM:");
console.log(`  sourceStartTime: ${sourceStartTime}s`);
console.log(`  clip shows source [${sourceStartTime}s, ${sourceStartTime + duration}s]`);

const fracBeforeLeft = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac: frac.toFixed(3), visible };
});
console.log(`  fractions: ${JSON.stringify(fracBeforeLeft)}`);
console.log(`  result: ${fracBeforeLeft.filter(f => f.visible).length} visible markers\n`);

// Trim LEFT: move startFrame from 0 to 60 frames (2 seconds)
// According to resizeTrackWithTrimming with fps=30:
// - timeDelta = (60 - 0) / 30 = 2 seconds
// - sourceStartTime = 0 + 2 = 2 seconds
// - endFrame stays 300
console.log("AFTER LEFT TRIM (startFrame 0->60 frames, i.e., trim off first 2s):");
startFrame = 60;
sourceStartTime = 2;  // 60 frames / 30 fps = 2 seconds
endFrame = 300;  // unchanged
duration = (endFrame - startFrame) / fps;

console.log(`  sourceStartTime: ${sourceStartTime}s`);
console.log(`  startFrame: ${startFrame}, endFrame: ${endFrame}`);
console.log(`  clip now shows source [${sourceStartTime}s, ${sourceStartTime + duration}s]`);
console.log(`  sceneMarkers still contains: ${markers.map(m => m.atSeconds).join(', ')}s`);

const fracAfterLeft = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac: frac.toFixed(3), visible };
});
console.log(`  fractions after render: ${JSON.stringify(fracAfterLeft)}`);
console.log(`  result: ${fracAfterLeft.filter(f => f.visible).length} visible markers`);
console.log(`  BUG: 2s marker is gone (was trimmed off)! But 5s and 7s should still be visible!\n`);

// The core issue
console.log("=== ANALYSIS ===");
console.log("The bug happens because:");
console.log("1. sceneMarkers stored with atSeconds=[2,5,7] based on ORIGINAL clip window [0,10]");
console.log("2. After right-trim to 5s, clip window is [0,5], but sceneMarkers unchanged");
console.log("3. Marker at 5s has frac = (5-0)/5 = 1.0, which is filtered by frac < 0.998");
console.log("4. User expects to see 2s and 5s markers visible in the trimmed 5s window");
console.log("5. Instead, all markers disappear silently with no explanation");
