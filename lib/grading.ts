/* Single source of truth for performance-level thresholds and the colours used
 * across charts, tables and the exported HTML report. Previously these strings
 * and hex values were duplicated in page.tsx and several API routes. */

export const LEVEL_EXCELLENT = "優秀(≥85%)";
export const LEVEL_GOOD = "良好(70-84%)";
export const LEVEL_AVERAGE = "一般(55-69%)";
export const LEVEL_WEAK = "需要改善(<55%)";

/** Distribution buckets in display order (best → worst). */
export const LEVEL_ORDER = [LEVEL_EXCELLENT, LEVEL_GOOD, LEVEL_AVERAGE, LEVEL_WEAK] as const;

/** Map a percentage (0–100) to its performance-level label. */
export function performanceLevel(pct: number): string {
  if (pct >= 85) return LEVEL_EXCELLENT;
  if (pct >= 70) return LEVEL_GOOD;
  if (pct >= 55) return LEVEL_AVERAGE;
  return LEVEL_WEAK;
}

/** Short CSS-class suffix (excellent/good/average/weak) for a percentage. */
export function levelClass(pct: number): "excellent" | "good" | "average" | "weak" {
  if (pct >= 85) return "excellent";
  if (pct >= 70) return "good";
  if (pct >= 55) return "average";
  return "weak";
}

/** Colour per distribution bucket, keyed by the level label. */
export const LEVEL_COLORS: Record<string, string> = {
  [LEVEL_EXCELLENT]: "#43a047",
  [LEVEL_GOOD]: "#1e88e5",
  [LEVEL_AVERAGE]: "#f9a825",
  [LEVEL_WEAK]: "#e53935",
};

/** Palette for course-strand series. */
export const STRAND_COLORS = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFB74D", "#BA68C8"];
