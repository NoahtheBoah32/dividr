import { sceneTimesToMarkers } from './src/shared/sceneDetection.ts';

// Test case: Scene detection on a clip, then clip is trimmed

console.log("=== VERIFICATION: Bug scenario with actual sceneDetection code ===\n");

// Initial detection: clip is [0, 10]s with markers at [2, 5, 7]
// sceneTimesToMarkers is called with:
//   scenes = [2, 5, 7] (absolute source times)
//   clipStartSec = 0 (sourceStartTime)
//   clipEndSec = 10 (sourceStartTime + duration)
const detected = sceneTimesToMarkers([2, 5, 7], 0, 10);
console.log("Detection (clip [0-10]s):");
console.log("  sceneTimesToMarkers([2,5,7], 0, 10) =", detected);
console.log("  Stored in track.sceneMarkers:\n", detected);

// These markers are STORED with atSeconds and fraction from the detection window
// Later, when clip is trimmed to [0-5]s, the rendering code recalculates fractions:

console.log("\n--- AFTER RIGHT TRIM (clip now [0-5]s) ---");
console.log("Rendering code does:");
console.log('  srcStart = track.sourceStartTime = 0');
console.log('  clipDurSec = (150 - 0) / 30 = 5');
console.log('  For each marker in sceneMarkers:');
console.log('    frac = (atSeconds - srcStart) / clipDurSec');

const markerAfterTrim = detected.map(m => {
  const frac = (m.atSeconds - 0) / 5;
  const visible = frac > 0.002 && frac < 0.998;
  return { ...m, newFrac: frac.toFixed(3), visible };
});

console.log("\nResult:", markerAfterTrim);
console.log("\nBUG CONFIRMED:");
console.log("- Marker at 5s has frac=1.000, filtered out (frac < 0.998 fails)");
console.log("- Marker at 7s has frac=1.400, filtered out (frac < 0.998 fails)");
console.log("- Only marker at 2s survives");
console.log("\nWhat SHOULD happen:");
console.log("- Markers 2s, 5s within the [0-5]s window should ALL be visible");
console.log("- Marker 7s is actually outside the new window and should be excluded");
console.log("- But 5s should be visible (it's the end boundary)");

console.log("\n--- THE FIX ---");
console.log("The 0.998 threshold is intended to hide markers at clip edges");
console.log("(those are typically not useful as split points).");
console.log("But after trimming, a marker at the edge of the NEW window is valid!");
console.log("");
console.log("Solution: Change filter from 'frac < 0.998' to 'frac <= 1.0'");
console.log("This allows markers that fall exactly at or within the clip bounds");
console.log("without being filtered as edge-hugging artifacts.");
