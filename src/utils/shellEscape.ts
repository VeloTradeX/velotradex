/**
 * Escapes a string for safe inclusion in a double-quoted shell argument.
 * Prevents command injection by escaping dangerous metacharacters.
 */
export function shellEscapeDoubleQuoted(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

/**
 * Validates that a value only contains safe characters for use as a
 * filter key (e.g., log level). Rejects shell metacharacters.
 */
export function isSafeFilterValue(value: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(value);
}
