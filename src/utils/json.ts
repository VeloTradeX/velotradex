/**
 * JSON.stringify replacement that converts BigInt values to strings.
 * The gate-api SDK deserializes FuturesOrder.id as BigInt, which
 * causes JSON.stringify to throw "Do not know how to serialize a BigInt".
 */
export function safeStringify(value: unknown, maxLength?: number): string {
  try {
    const str = JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (maxLength && str.length > maxLength) {
      return str.slice(0, maxLength) + '...[truncated]';
    }
    return str;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Deep-convert all BigInt values in a JSON-serializable structure to strings.
 * The gate-api SDK deserializes FuturesOrder.id (and nested raw fields) as BigInt,
 * which causes plain JSON.stringify (e.g. Koa ctx.body) to throw
 * "Do not know how to serialize a BigInt". Use this before returning exchange
 * data through HTTP routes so the response always serializes cleanly.
 */
export function normalizeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') {
    return value.toString() as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeBigInts(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = normalizeBigInts((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * 宽松 JSON 解析：兼容 LLM 输出中常见的非严格 JSON 问题——
 * - 键未加双引号（{action: "open"}）
 * - 字符串用单引号（'open'）
 * - 数组/对象尾随逗号（[1, 2,]）
 * - 前导/尾随说明文字（提取首个 { 到最后一个 } 之间的内容）
 *
 * 返回解析结果；若所有修复尝试都失败则返回 null。
 */
export function parseRelaxedJson<T = unknown>(content: string): T | null {
  if (!content || typeof content !== 'string') return null;

  const candidates: string[] = [];
  let trimmed = content.trim();

  // 1. 去除 markdown 代码块围栏
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }

  candidates.push(trimmed);

  // 2. 提取首个 { 到最后一个 } 之间的内容（去除前后杂质文字）
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  // 3. 对每个候选做逐级修复尝试
  for (const candidate of candidates) {
    const direct = tryParseJson(candidate);
    if (direct !== null) return direct as T;

    // 修复 1: 尾随逗号
    const noTrailing = candidate.replace(/,\s*([}\]])/g, '$1');
    const repaired1 = tryParseJson(noTrailing);
    if (repaired1 !== null) return repaired1 as T;

    // 修复 2: 未加引号的键 {key: ...} -> {"key": ...}
    const quotedKeys = noTrailing.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    const repaired2 = tryParseJson(quotedKeys);
    if (repaired2 !== null) return repaired2 as T;

    // 修复 3: 单引号字符串 '...' -> "..."
    const doubleQuoted = quotedKeys.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    const repaired3 = tryParseJson(doubleQuoted);
    if (repaired3 !== null) return repaired3 as T;
  }

  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
