/* Shared helpers for parsing (and repairing) JSON returned by the LLM.
 * Previously duplicated across every API route. */

/** Raw control chars that are illegal inside JSON strings (built via RegExp
 * so the source file contains no literal control characters). */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

/** Escape stray backslashes (e.g. LaTeX \frac, \(, \)) and strip raw control
 * chars so a model reply that is "almost JSON" still parses. */
export function sanitizeJson(text: string): string {
  return text
    .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
    .replace(CONTROL_CHARS, "");
}

/** Try strict JSON.parse, then a sanitized retry. Returns null if both fail. */
export function tryParse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(sanitizeJson(text)); } catch {}
  return null;
}

/**
 * Best-effort parse of a model reply into an object:
 * direct → sanitized → fenced ```json block → first {...} span.
 * Falls back to `{ raw_response, parse_error: true }`.
 *
 * @param rawLimit how many chars of the raw text to keep in raw_response.
 */
export function parseJson(text: string, rawLimit = 500): Record<string, unknown> {
  const direct = tryParse(text);
  if (direct) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) { const r = tryParse(fenced[1]); if (r) return r; }
  const braced = text.match(/(\{[\s\S]*\})/);
  if (braced) { const r = tryParse(braced[1]); if (r) return r; }
  return { raw_response: text.slice(0, rawLimit), parse_error: true };
}

/**
 * Salvage complete objects from a truncated/garbled array that follows a given
 * key (e.g. "questions_found"). Returns every well-formed `{...}` element found.
 */
export function extractCompleteObjects(text: string, afterKey?: string): Record<string, unknown>[] {
  const keyIndex = afterKey ? text.indexOf(afterKey) : -1;
  const arrayStart = text.indexOf("[", keyIndex >= 0 ? keyIndex : 0);
  if (arrayStart < 0) return [];

  const objects: Record<string, unknown>[] = [];
  let depth = 0, inString = false, escaped = false, objectStart = -1;
  for (let i = arrayStart + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { if (depth === 0) objectStart = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        const slice = text.slice(objectStart, i + 1);
        const obj = tryParse(slice);
        if (obj) objects.push(obj);
        objectStart = -1;
      }
    }
  }
  return objects;
}

/**
 * Repair a reply whose `question_results` array was cut off mid-stream by
 * keeping only the complete question objects. Returns the repaired object with
 * `_repaired: true`, or null if nothing salvageable.
 */
export function repairTruncatedQuestionResults(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const head = text.slice(start);
  const arrIdx = head.indexOf("\"question_results\"");
  if (arrIdx < 0) return null;
  const bracket = head.indexOf("[", arrIdx);
  if (bracket < 0) return null;

  let depth = 0, inStr = false, esc = false, lastGood = -1;
  for (let i = bracket + 1; i < head.length; i++) {
    const ch = head[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) lastGood = i; }
    else if (ch === "]" && depth === 0) { lastGood = i - 1; break; }
  }
  if (lastGood <= bracket) return null;
  const obj = tryParse(head.slice(0, lastGood + 1) + "]}");
  if (obj) { obj._repaired = true; return obj; }
  return null;
}
