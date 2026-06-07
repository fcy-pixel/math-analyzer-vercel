/* Client helpers for the /ask page: render KaTeX to HTML and lightly sanitize
 * model-produced SVG before injecting it. */
import katex from "katex";

/** Render a KaTeX expression to an HTML string. Falls back to the raw text on
 * error so a bad formula never breaks the page. */
export function renderMath(tex: string, displayMode = false): string {
  if (!tex) return "";
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode });
  } catch {
    return tex;
  }
}

/** Strip <script> tags and inline event handlers from model-produced SVG.
 * Only returns content that actually looks like an <svg> element. */
export function sanitizeSvg(svg: string): string {
  if (!svg || typeof svg !== "string") return "";
  const trimmed = svg.trim();
  if (!trimmed.toLowerCase().startsWith("<svg")) return "";
  return trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}
