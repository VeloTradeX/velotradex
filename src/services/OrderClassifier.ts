export function isScopedProtectionOrder(order: any, orderIds: number[], strategyIds: number[]): boolean {
    const text = String(order?.text || order?.initial?.text || '');
    if (!text) return false;
    for (const id of orderIds) {
        if (text.includes(`-ord-${id}`)) return true;
    }
    for (const id of strategyIds) {
        if (text.includes(`-strategy-${id}`)) return true;
    }
    return false;
}

export function isReduceOnlyOrder(order: any): boolean {
    const raw = order?.raw || order;
    return raw?.reduce_only === true || raw?.is_reduce_only === true || order?.reduceOnly === true;
}

export function isScopedOpenOrder(
    order: any,
    orderIds: number[],
    strategyIds: number[],
    expectedPositionSide: 'buy' | 'sell'
): boolean {
    const raw = order?.raw || order;
    const text = String(raw?.text || order?.text || raw?.initial?.text || '');
    const isReduceOnly = isReduceOnlyOrder(order);

    const matchesScopeText = isScopedProtectionOrder(raw, orderIds, strategyIds)
        || isScopedProtectionOrder(order, orderIds, strategyIds);
    if (matchesScopeText) return true;

    if (!isReduceOnly || !text.includes('t-tp-')) return false;
    const rawSize = parseFloat(raw?.size ?? order?.amount ?? '0');
    const fallbackSide = String(order?.side || '').toLowerCase();
    const orderSide = Number.isFinite(rawSize) && rawSize !== 0
        ? (rawSize < 0 ? 'sell' : 'buy')
        : (fallbackSide === 'sell' || fallbackSide === 'buy' ? fallbackSide : '');
    const expectedCloseSide = expectedPositionSide === 'buy' ? 'sell' : 'buy';
    return orderSide === expectedCloseSide;
}

export function isStopLossOrder(priceOrder: any, side?: 'buy' | 'sell'): boolean {
    const expectedRule = side === 'buy' ? 2 : side === 'sell' ? 1 : undefined;
    const text = String(priceOrder?.text || priceOrder?.initial?.text || '');
    if (text.includes('sl-')) return true;
    if (text.includes('tp-') || text.includes('take-profit')) return false;

    if (priceOrder?.type && typeof priceOrder.type === 'string' && priceOrder.type.toLowerCase().includes('stop-loss')) {
        return true;
    }
    if (priceOrder?.stopLoss) return true;

    const rule = priceOrder?.trigger?.rule;
    if (rule) {
        if (expectedRule && rule === expectedRule) return true;
        if (!expectedRule && priceOrder?.initial?.order_type) {
            const type = String(priceOrder.initial.order_type);
            if (type.includes('close') || priceOrder.initial.reduce_only || priceOrder.initial.auto_size) {
                return true;
            }
        }
    }

    return false;
}

export function isTakeProfitTriggerOrder(priceOrder: any, side: 'buy' | 'sell'): boolean {
    const tpRule = side === 'buy' ? 1 : 2;
    const expectedOrderType = side === 'buy' ? 'close-long-position' : 'close-short-position';
    const text = String(priceOrder?.text || priceOrder?.initial?.text || '');

    if (text.includes('sl-') || text.includes('close-')) return false;
    if (text.includes('tp-') || text.includes('take-profit')) return true;

    if (priceOrder?.trigger?.rule !== tpRule) return false;

    const orderType = String(priceOrder?.order_type || priceOrder?.initial?.order_type || '');
    if (orderType === expectedOrderType) return true;
    if (priceOrder?.initial?.reduce_only) return true;

    return false;
}

export function isReduceOnlyTpOpenOrder(openOrder: any, side: 'buy' | 'sell'): boolean {
    const raw = openOrder?.raw || openOrder;
    const text = String(raw?.text || openOrder?.text || '');
    if (text.includes('sl-') || text.includes('close-') || text.includes('stop')) return false;
    const isReduceOnly = raw?.reduce_only === true || raw?.is_reduce_only === true || openOrder?.reduceOnly === true;
    if (!isReduceOnly) return false;

    const rawSize = parseFloat(raw?.size ?? openOrder?.amount ?? '0');
    const fallbackSide = String(openOrder?.side || '').toLowerCase();
    const orderSide = Number.isFinite(rawSize) && rawSize !== 0
        ? (rawSize < 0 ? 'sell' : 'buy')
        : (fallbackSide === 'sell' || fallbackSide === 'buy' ? fallbackSide : '');
    const expectedCloseSide = side === 'buy' ? 'sell' : 'buy';
    if (orderSide !== expectedCloseSide) return false;

    const orderPrice = parseFloat(raw?.price || openOrder?.price || '0');
    return Number.isFinite(orderPrice) && orderPrice > 0;
}

export function extractTpStepFromRawMessage(raw: any): number | null {
    const content = String(raw?.content || '').toLowerCase();
    if (!content) return null;
    const ordinalMatch = content.match(/\b(first|second|third|fourth|fifth)\s+tp\b/);
    if (ordinalMatch) {
        const ordinalMap: Record<string, number> = {
            first: 1,
            second: 2,
            third: 3,
            fourth: 4,
            fifth: 5,
        };
        return ordinalMap[ordinalMatch[1]] || null;
    }
    const m1 = content.match(/\btp\s*([1-9]\d?)\b/);
    if (m1) return parseInt(m1[1], 10);
    const m2 = content.match(/\btp([1-9]\d?)\b/);
    if (m2) return parseInt(m2[1], 10);
    return null;
}
