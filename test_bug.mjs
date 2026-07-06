// Simulate the bug scenario from the report

// Scenario:
// 1. Original clip: sourceStartTime=0, duration=10s, fps=30
//    Scene markers detected at source times: [50s, 100s, 150s, 200s]
// 2. User trims right edge from 300 to 150 frames (10s to 5s)
// 3. Check what fractions are computed in SceneMarkers

const fps = 30;

// Initial state
let sourceStartTime = 0;
let startFrame = 0;
let endFrame = 300;  // 10 seconds of content
let duration = (endFrame - startFrame) / fps;

const markers = [
  { atSeconds: 50 },
  { atSeconds: 100 },
  { atSeconds: 150 },
  { atSeconds: 200 }
];

console.log("=== BEFORE TRIM ===");
console.log(`sourceStartTime: ${sourceStartTime}s`);
console.log(`clip duration: ${duration}s (frames ${startFrame}-${endFrame})`);
console.log(`clip shows source window: [${sourceStartTime}s, ${sourceStartTime + duration}s]`);

// Compute fractions BEFORE trim
const fracBefore = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac, visible };
});
console.log("Marker fractions before trim:", fracBefore);

// NOW: User trims right edge from 300 to 150 frames (30 to 150 frames)
// According to resizeTrackWithTrimming:
// - Right trim: startFrame stays same, sourceStartTime stays same
// - Only endFrame changes

console.log("\n=== AFTER RIGHT TRIM (300 -> 150 frames) ===");
endFrame = 150;  // Trimmed from 300 to 150 frames
duration = (endFrame - startFrame) / fps;  // Now 5 seconds

console.log(`sourceStartTime: ${sourceStartTime}s (unchanged)`);
console.log(`clip duration: ${duration}s (frames ${startFrame}-${endFrame})`);
console.log(`clip shows source window: [${sourceStartTime}s, ${sourceStartTime + duration}s]`);

// Compute fractions AFTER trim - THIS IS WHERE THE BUG OCCURS
const fracAfter = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac, visible };
});
console.log("Marker fractions after trim:", fracAfter);
console.log("\nResult: ALL markers are filtered out by the 0.002 < frac < 0.998 check");

// Scenario 2: Left trim
console.log("\n\n=== SCENARIO 2: LEFT TRIM ===");
sourceStartTime = 0;
startFrame = 0;
endFrame = 300;
duration = (endFrame - startFrame) / fps;

console.log("=== BEFORE LEFT TRIM ===");
console.log(`sourceStartTime: ${sourceStartTime}s`);
console.log(`clip duration: ${duration}s (frames ${startFrame}-${endFrame})`);
console.log(`clip shows source window: [${sourceStartTime}s, ${sourceStartTime + duration}s]`);

const fracBeforeLeft = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac, visible };
});
console.log("Marker fractions before left trim:", fracBeforeLeft);

// User trims LEFT edge from 0 to 100 frames
// According to resizeTrackWithTrimming:
// - Left trim: endFrame stays same, sourceStartTime INCREASES
// - frameDelta = 100 - 0 = 100 frames
// - timeDelta = 100/30 = 3.33 seconds
// - newSourceStartTime = 0 + 3.33 = 3.33s

console.log("\n=== AFTER LEFT TRIM (0 -> 100 frames) ===");
startFrame = 100;
sourceStartTime = (100 / fps);  // 3.33 seconds
duration = (endFrame - startFrame) / fps;  // Still 300-100=200 frames = 6.67s

console.log(`sourceStartTime: ${sourceStartTime.toFixed(2)}s`);
console.log(`clip duration: ${duration.toFixed(2)}s (frames ${startFrame}-${endFrame})`);
console.log(`clip shows source window: [${sourceStartTime.toFixed(2)}s, ${(sourceStartTime + duration).toFixed(2)}s]`);

const fracAfterLeft = markers.map(m => {
  const frac = (m.atSeconds - sourceStartTime) / duration;
  const visible = frac > 0.002 && frac < 0.998;
  return { atSeconds: m.atSeconds, frac: frac.toFixed(2), visible };
});
console.log("Marker fractions after left trim:", fracAfterLeft);
console.log("\nResult: Most markers still filtered out because their source times");
console.log("are far beyond the clip's NEW source window");

// The REAL issue: markers were detected for the original clip range,
// but they're stored as absolute source times. When you trim the clip,
// sceneMarkers still contains ORIGINAL markers, not trimmed-range markers.
// And the rendering code tries to map them anyway, causing out-of-range filtering.

console.log("\n\n=== CORE ISSUE ===");
console.log("sceneMarkers are stored with atSeconds as ABSOLUTE source time.");
console.log("When clip is trimmed, the same marker array persists.");
console.log("The rendering code does: frac = (atSeconds - sourceStartTime) / clipDurSec");
console.log("This only works if the marker is actually within [sourceStartTime, sourceStartTime+clipDurSec]");
console.log("");
console.log("If user trims right 10s->5s with sourceStartTime=0:");
console.log("  markers at [50, 100, 150, 200] all become frac > 1, filtered out");
console.log("  NO ERROR OR WARNING — user sees no markers");
console.log("");
console.log("The sceneMarkers are FROZEN at detection time, but don't reflect");
console.log("the new visible source window after trimming.");
