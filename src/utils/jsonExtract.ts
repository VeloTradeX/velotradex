/**
 * Best-effort extraction of the first complete JSON object from an LLM reply.
 *
 * Models occasionally append tool-call leftovers (e.g. `<function...`) or a
 * short explanation after an otherwise valid JSON object. `JSON.parse` on the
 * whole string throws in that case and the whole message is dropped, which is
 * unacceptable for close/update signals. This helper scans for the first `{`
 * and returns the balanced object, ignoring anything before/after it.
 *
 * Returns null when no balanced object can be found (e.g. truncated output).
 */
export function extractFirstJsonObject(content: string): string | null {
  if (!content) return null;

  let text = String(content).trim();

  // Strip a leading markdown code fence: ```json ... ```
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '');
    // Keep the first fenced block if there is one, otherwise fall through.
    const closingFence = text.indexOf('```');
    if (closingFence >= 0) text = text.slice(0, closingFence);
  }

  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}
