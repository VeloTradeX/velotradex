/**
 * Raizexbt 频道确定性风控规则（不依赖 LLM）。
 *
 * 背景：该频道有一整套稳定的「发帖习惯」，但 LLM 视觉/文本模型会漂移：
 * - 风险倍数方向：`risky` / `high risk` 反而被放大成 2R（实际交易员是缩到 0.5R）；
 * - 「半 R 规则」：仓位开出来后，紧跟一条 `0.5R` / `0.3R` 的独立消息，表示该单风险要改成 0.5R；
 * - 部分平仓：`Tp1` / `Partials` / `Runner left` 后顺手把止损移到保本；
 * - 取消挂单：`No limits for now` / `Cutting this entry`；
 * - 期望性措辞：`full tp soon` 只是期望，不是指令。
 *
 * 本模块只被 Raizexbt 解析链路引用，其他解析器不加载、不受影响。
 */

/** 半 R 规则的时间窗口：风险便签与开仓信号互相匹配的最大间隔。 */
export const RISK_NOTE_WINDOW_MS = 120_000;

/** 去掉角色提及、markdown、emoji 等噪音，统一小写与空白。 */
export function normalizeRuleText(text: string): string {
    return String(text || '')
        .replace(/<@&\d+>/g, ' ')
        .replace(/<@!?\d+>/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[*_`~]/g, ' ')
        .replace(/[\u4e00-\u9fa5]/g, ' ')
        .replace(/[\u3000-\u303f\uff00-\uffef]/g, ' ')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** 去掉引用块（"> ..."）与 URL：它们只是消息前缀/引用历史，不参与当前指令判定。 */
export function stripQuotedPrefix(text: string): string {
    return String(text || '')
        .split(/\n+/)
        .filter(line => !/^\s*>/.test(line))
        .join('\n')
        .replace(/https?:\/\/\S+/gi, ' ');
}

/** 去掉重复行（Discord 翻译常见的 "0.5R\n\n0.5R"）。 */
function dedupeLines(text: string): string {
    const seen = new Set<string>();
    const lines = text
        .split(/\n+/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => {
            if (seen.has(line)) return false;
            seen.add(line);
            return true;
        });
    return lines.join(' ');
}

/**
 * 从文本中解析「仓位风险倍数」（riskMultiplier）。
 *
 * 交易员口径：
 * - `risky` / `high risk` / `high-risk` / `low risk` / `reduced risk` / `half R` = 0.5（缩仓）
 * - `0.3-0.5R` / `0.2-0.5R` 这类区间 = 取低值（0.3）
 * - `0.25R` / `quarter size` = 0.25，`0.3R` = 0.3
 * - `1R` / `1R risk` / `normal` / `full size` = 1.0
 * - `2R+` / `2.5RR+` / `-0.5R` 是**结果/复盘**，不是仓位，一律不解析
 *
 * 返回 undefined 表示文本没有仓位风险含义（默认 1R）。
 */
export function resolveRiskMultiplierFromText(text: string): number | undefined {
    const raw = dedupeLines(String(text || '')).toLowerCase();
    if (!raw) return undefined;

    // 结果/复盘口径直接排除：-0.5R、2R+、2.5RR+、took/gained/up/profit 等。
    if (/\b(took|made|gained|profit|profit|results?|recap|weekly|monthly|already)\b/.test(raw)) {
        // "took 0.5R" 之类是战绩；但 "took this 1R risk" 是仓位说明，单独放行。
        if (!/\b(1|0?\.\d+)\s*r\s*risk\b/.test(raw)) return undefined;
    }

    const norm = raw
        .replace(/\b(rr|r)\s*\+/g, ' ') // "2R+" / "2RR+" 是结果
        .replace(/(?:^|[\s(])-\s*\d+(?:\.\d+)?\s*r\b/g, ' '); // 独立 "-0.5R" 是亏损结果

    // 区间："0.3-0.5R"、"0.2 - 0.5R" → 取低值。
    const range = norm.match(/(?:^|[^0-9.])((?:0?\.\d+))\s*(?:-|~|–|—|to)\s*((?:0?\.\d+))\s*r\b/);
    if (range) {
        const low = Number.parseFloat(range[1]);
        const high = Number.parseFloat(range[2]);
        if (Number.isFinite(low) && Number.isFinite(high) && low > 0) {
            return Math.min(low, high);
        }
    }

    // "taking this 1R risk" / "1r risk" / "risk 1r"
    if (/\b(?:1|1\.0+)\s*r\s*risk\b/.test(norm) || /\brisk\s*(?:of\s*)?(?:1|1\.0+)\s*r\b/.test(norm)) {
        return 1;
    }

    // 明确的缩仓/加仓措辞。
    if (/\b(?:quarter|0\.25)\s*(?:size|r)\b/.test(norm)) return 0.25;
    if (/\b(?:half|\.5|0\.5)\s*(?:size|r)\b/.test(norm)) return 0.5;
    if (/\b(?:risky|high[\s-]*risk|low[\s-]*risk|reduced[\s-]*risk|smaller[\s-]*size)\b/.test(norm)) return 0.5;
    if (/\b(?:full\s*size|normal\s*risk)\b/.test(norm)) return 1;

    // 数字 R：0.3R / .5R / 0.25R / 1R（排除 2.5R 这类 RR 报告：前一位不能是数字或小数点）。
    const rMatch = norm.match(/(?:^|[^0-9.])((?:0?\.\d+)|(?:1(?:\.0+)?))\s*r\b(?!\s*(?:risk)?\s*\+)/);
    if (rMatch) {
        const value = Number.parseFloat(rMatch[1]);
        if (Number.isFinite(value) && value > 0 && value <= 1) {
            return value;
        }
    }

    // 百分比口径："manage your risk ... 1% or 0.5%" → 取较低值。
    const percentMatches = Array.from(norm.matchAll(/\b(0?\.\d+|\d(?:\.\d+)?)\s*%/g))
        .map(match => Number.parseFloat(match[1]))
        .filter(value => Number.isFinite(value) && value > 0 && value <= 2);
    if (percentMatches.length > 0 && /\b(risk|size|size|trade|manage)\b/.test(norm)) {
        return Math.min(...percentMatches);
    }

    return undefined;
}

export interface StandaloneRiskNote {
    multiplier: number;
    /** 命中的风险表达（用于日志/审计）。 */
    label: string;
}

const RISK_CORE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /^(?:use\s+|use\s+the\s+)?(?:risk\s*:?\s*)?(?:of\s+)?(0?\.\d+)\s*(?:-|~|–|—|to)\s*(0?\.\d+)\s*r(?:\s*only)?$/, label: 'risk-range' },
    { pattern: /^(?:use\s+|use\s+the\s+)?(?:risk\s*:?\s*)?(?:of\s+)?(0?\.\d+|1(?:\.0+)?)\s*r(?:\s*risk)?$/, label: 'risk-number' },
    { pattern: /^(?:use\s+|use\s+the\s+)?(?:risk\s*:?\s*)?(?:of\s+)?(?:risky|high[\s-]*risk|low[\s-]*risk|reduced[\s-]*risk)$/, label: 'risk-word' },
    { pattern: /^(?:use\s+|use\s+the\s+)?(?:risk\s*:?\s*)?(?:of\s+)?(?:half|half\s*size|half\s*r|quarter\s*size|quarter\s*r|full\s*size)$/, label: 'risk-size' },
    { pattern: /^(?:taking\s+)?(?:this\s+)?(1(?:\.0+)?|0?\.\d+)\s*r\s*risk$/, label: 'risk-explicit' },
];

/**
 * 判断整条消息是否只是「风险便签」（除了风险倍数没有任何交易动作）。
 *
 * 例如：`0.5R`、`.5R`、`Risk 0.5R`、`USE 0.5R ON THIS TRADE`、`low risk`、
 * `Low risk> 0.3-0.5R only`、`Low risk again`、`half R`。
 */
export function detectStandaloneRiskNote(text: string): StandaloneRiskNote | null {
    const raw = dedupeLines(stripQuotedPrefix(text));
    if (!raw) return null;

    let normalized = normalizeRuleText(raw);
    if (!normalized) return null;

    // 去掉常见前后缀/连接符："low risk> 0.3-0.5r only" → "low risk 0.3-0.5r only"
    normalized = normalized
        .replace(/[>|:;,]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // 去掉尾部限定语，便于精确匹配。
    const suffixes = [
        'on this trade', 'on this one', 'on this', 'for this trade', 'for this',
        'this trade', 'this one', 'again', 'only', 'please', 'now', 'today',
    ];
    const stripSuffix = (value: string): string => {
        let out = value;
        let changed = true;
        while (changed) {
            changed = false;
            for (const suffix of suffixes) {
                const re = new RegExp(`(?:\\s+|^)${suffix.replace(/\s+/g, '\\s+')}$`);
                if (re.test(out)) {
                    out = out.replace(re, '').trim();
                    changed = true;
                }
            }
        }
        return out;
    };

    const candidates = [normalized];
    // 中英混排（"Risk 0.5R / 风险为0.5R"）去掉中文后可能出现重复 token，去重后再尝试。
    const uniqueTokens = normalized.split(' ').filter((token, index, all) => token && all.indexOf(token) === index).join(' ');
    if (uniqueTokens && uniqueTokens !== normalized) candidates.push(uniqueTokens);
    const stripped = stripSuffix(normalized);
    if (stripped && stripped !== normalized) candidates.push(stripped);
    const strippedUnique = stripSuffix(uniqueTokens);
    if (strippedUnique && !candidates.includes(strippedUnique)) candidates.push(strippedUnique);
    // "low risk 0.3-0.5r" → 取后半段数字表达。
    const splitted = normalized.match(/\b(low[\s-]*risk|high[\s-]*risk|risky)\b.*?\b((?:0?\.\d+)\s*(?:-|~|–|—|to)\s*(?:0?\.\d+)\s*r)\b/);
    if (splitted) candidates.push(splitted[2]);

    for (const candidate of candidates) {
        for (const { pattern, label } of RISK_CORE_PATTERNS) {
            if (pattern.test(candidate)) {
                const multiplier = resolveRiskMultiplierFromText(candidate);
                if (multiplier != null) return { multiplier, label };
            }
        }
    }

    return null;
}

/** 交易动作词：出现这些词说明该消息不是纯风险便签。 */
export function isTradeIntentText(text: string): boolean {
    const norm = normalizeRuleText(text);
    return /\b(longed?|shorted?|scalp(?:ed|ing)?|entered?|entry|entries|limit|market|open(?:ed|ing)?|close(?:d|ing)?|cut(?:ting)?|partials?|partialed|trim(?:med)?|tp\d?|targets?|stop(?:s|ped)?|sl|breakeven|dca|add(?:ing)?|average|taking|took|bought|sold)\b/.test(norm);
}

/**
 * 「当前不挂限价/取消挂单」意图。
 * 仅匹配明确措辞，避免把 "Not limit / manual watching" 之类误判（用户未标注该条）。
 */
export function isCancelEntryIntent(text: string): boolean {
    const norm = normalizeRuleText(text);
    if (!norm) return false;
    return (
        /\bno (?:limits?|orders?) (?:for now|now|yet|at the moment)\b/.test(norm)
        || /\bnot setting (?:any )?(?:limits?|orders?)\b/.test(norm)
        || /\b(?:remove|cancel|kill|delete) (?:the |all |my )?(?:limits?|orders?)\b/.test(norm)
        || /\b(?:no|without) (?:more |new )?limits?\b/.test(norm)
        || /\bcutting (?:this|the) entry\b/.test(norm)
        || /\bcancel (?:this|the) entry\b/.test(norm)
        || /\bnot entering\b/.test(norm)
    );
}

/** "cutting/cancel this entry" 语义：未成交 → 撤单；已成交 → 平仓。 */
export function isCuttingEntryIntent(text: string): boolean {
    const norm = normalizeRuleText(text);
    return /\bcutting (?:this|the) entry\b/.test(norm)
        || /\bcancel (?:this|the) entry\b/.test(norm)
        || /\bcut (?:this|the) entry\b/.test(norm);
}

/**
 * 期望性/条件性措辞（不是指令）。
 * 例：`full tp soon`、`stops alr flat`（状态陈述）、`might nuke`、`will close if ...`。
 * 注意：`will close if we get breakeven` 是明确条件管理，由 BE 规则单独处理，
 * 这里只用于拦截「期望全平」。
 */
export function isFullCloseExpectation(text: string): boolean {
    const norm = normalizeRuleText(stripQuotedPrefix(text));
    if (!norm) return false;

    // 文本里同时带明确的管理/离场动作时，不能按「期望性措辞」忽略：
    // 例："Partials and manage accordingly / Full tp will hit" 仍然是分批止盈指令；
    //     "Stops to entry / Should give us full tp" 仍然是移保本指令。
    const hasExplicitManagementAction = /\b(partials?|partialed|closing|closed|cutting|cut|trim(?:med)?|scale[ds]?\s*out|stops?\s+(?:to\s+)?(?:entry|be|breakeven)|sl\s+(?:to\s+)?(?:entry|be|breakeven)|stops?\s+be|breakeven|tped|tp\d|taking\s+some\s+off)\b/.test(norm);
    if (hasExplicitManagementAction) return false;

    const hasFullTp = /\b(?:full|all)\s+(?:tp|take\s*profit|targets?)\b/.test(norm);
    if (!hasFullTp) return false;
    return /\b(soon|will|gonna|going to|might|maybe|probably|expect|hopefully|should|could|waiting|wait for)\b/.test(norm);
}

/** DCA / 加仓语义（豁免近似重复拦截）。 */
export function isDcaText(text: string): boolean {
    const norm = normalizeRuleText(text);
    return /\bdca\b/.test(norm)
        || /\badding (?:here|more|to (?:my |the )?position)\b/.test(norm)
        || /\baveraging (?:in|down|up)\b/.test(norm)
        || /\badd(?:ing)? to (?:my |the )?position\b/.test(norm);
}

/**
 * 「到 1R 后管理仓位」语义：表示 1R 处平掉一部分并移动保本。
 * 例：`Can manage your position after 1R accordingly`、`manage after 1R`。
 */
export function isOneRManagementPlan(text: string): boolean {
    const norm = normalizeRuleText(text);
    if (!norm) return false;
    if (/\bmanage\b[^.]{0,40}\b(?:after|at|from)\s*1\s*r\b/.test(norm)) return true;
    if (/\b(?:after|at)\s*1\s*r\b[^.]{0,40}\b(?:manage|management|partials?|breakeven|be|move stop)\b/.test(norm)) return true;
    return false;
}

/** "Runner left" 语义：大部分已平、留小仓位跑 → 平 80% + 移 BE。 */
export function isRunnerLeftIntent(text: string): boolean {
    const norm = normalizeRuleText(text);
    return /\brunner(?:s)?\s+left\b/.test(norm)
        || /\bonly\s+(?:a\s+)?runner\b/.test(norm)
        || /\bleft\s+(?:a\s+)?runner\b/.test(norm)
        || /\bleaving (?:a\s+)?runners?\b/.test(norm);
}

/**
 * 「条件性回到入场价就平仓」语义：交易员打算在价格回到入场价时离场。
 *
 * 必须只匹配**条件/将来**语气（"will close if we get breakeven"），
 * 不能匹配立即执行的 "Closing this at entry"（那是当次平仓指令，不是管理计划）。
 */
export function isExitAtBreakevenIntent(text: string): boolean {
    const norm = normalizeRuleText(text);
    if (!norm) return false;
    if (/\b(?:closing|closed|closing out|cutting)\b/.test(norm) && !/\b(?:will|would|gonna|going to|plan|if|when|once|wait)\b/.test(norm)) {
        return false;
    }
    return /\b(?:will|would|gonna|going to|plan(?:ning)? to|wait(?:ing)?(?: for)?)\b[^.]{0,40}\b(?:close|exit|out|cut)\b[^.]{0,20}\b(?:breakeven|break[\s-]*even|be|entry)\b/.test(norm)
        || /\b(?:close|exit|cut)\b[^.]{0,25}\b(?:if|when|once)\b[^.]{0,25}\b(?:breakeven|break[\s-]*even|be|entry)\b/.test(norm)
        || /\bwill close if we get (?:breakeven|break[\s-]*even|be)\b/.test(norm);
}
