const MARKET_PRICE_INFERENCE_RULES = [
    'Use <market_prices> as cached reference prices for common markets.',
    'If there are no active positions and the current message text and screenshot contain no explicit symbol, infer the symbol by comparing visible chart price levels with <market_prices>.',
    'Choose the symbol with the closest current price when the chart price scale is clearly closest to one listed market.',
    'Do not default to BTC_USDT when symbol evidence is missing; use price proximity or return action:ignore with low confidence.'
].join(' ');

export function escapeXML(text: string): string {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function extractMessageText(message: any): string {
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') {
        const firstEmbedDescription = Array.isArray(message.embeds)
            ? String(message.embeds[0]?.description || '').trim()
            : '';
        if (firstEmbedDescription) return firstEmbedDescription;
        if (message.content) return String(message.content);
    }
    return JSON.stringify(message);
}

export function buildPrompt(params: {
    message: any;
    currentPrice: number;
    contextXml: string;
    positionsXml: string;
    marketPricesXml?: string;
    promptTemplate: string;
    stripChinese: boolean;
}): string {
    const { message, currentPrice, contextXml, positionsXml, marketPricesXml = '', promptTemplate, stripChinese } = params;

    let messageContent = extractMessageText(message);

    if (stripChinese) {
        messageContent = messageContent.replace(/[\u4e00-\u9fa5]/g, '');
    }

    let template = promptTemplate;
    const hasMarketPricesPlaceholder = template.includes('{{marketPrices}}');

    template = template.split('{{currentPrice}}').join(currentPrice.toString());
    template = template.split('{{context}}').join(contextXml);
    template = template.split('{{positions}}').join(positionsXml);
    template = template.split('{{marketPrices}}').join(marketPricesXml);
    template = template.split('{{message}}').join(messageContent);

    return [
        template,
        hasMarketPricesPlaceholder ? '' : marketPricesXml,
        `<market_price_inference_rules>${MARKET_PRICE_INFERENCE_RULES}</market_price_inference_rules>`
    ].filter(Boolean).join('\n\n');
}
