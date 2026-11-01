/**
 * Gate.io futures WS order events carry signed `size` and `left` values:
 * a sell order that was cancelled reports `size = -49`, `left = -49`, and a
 * partially filled sell reports `size = -98`, `left = -49`.
 *
 * Computing filled quantity as `|size| - left` (the previous implementation)
 * turns a cancelled sell into a fake full fill: `49 - (-49) = 98`. That made
 * cancelled TP orders look like TP fills, moved SL to breakeven, and corrupted
 * order/position state. Use absolute values on both sides instead.
 */
export function computeGateFilledQty(size: unknown, left: unknown): number {
  const rawSize = Number(size);
  if (!Number.isFinite(rawSize)) return 0;

  const absSize = Math.abs(rawSize);
  if (left === null || left === undefined || left === '') return absSize;

  const rawLeft = Number(left);
  if (!Number.isFinite(rawLeft)) return absSize;

  const absLeft = Math.abs(rawLeft);
  return Math.max(0, Math.min(absSize, absSize - absLeft));
}
