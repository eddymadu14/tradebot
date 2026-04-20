// engine/scoring.js
import { CONFIG } from "./config.js";

export function scoreSignal({
  volumeZ,
  rvol,
  atrCompressed,
  oiRising,
  sweep,
  structure,
  funding
}) {
  let score = 0;

  if (volumeZ > CONFIG.VOLUME_Z_THRESHOLD) score += 3;
  if (rvol > CONFIG.RVOL_THRESHOLD) score += 2;
  if (atrCompressed) score += 2;
  if (oiRising) score += 3;
  if (sweep) score += 3;
  if (structure !== "RANGE") score += 2;
  if (Math.abs(funding) > 0.01) score += 1;

  return score;
}
