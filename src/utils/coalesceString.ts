export function firstString(...values: unknown[]): string {
  const found = values.find(v => v !== undefined && v !== null);
  return found != null ? String(found) : '';
}
