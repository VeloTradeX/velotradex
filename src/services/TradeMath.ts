export function parsePositiveAmount(value: any): number | null {
    const n = parseFloat(String(value ?? '').trim());
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export function parseFinitePositiveNumber(value: any): number | null {
    const n = Number(typeof value === 'string' ? value.trim() : value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export function isCmpEntryPrice(value: any): boolean {
    return typeof value === 'string' && value.trim().toUpperCase() === 'CMP';
}

export function isFilledOrderStatus(status: any): boolean {
    return status === 'finished' || status === 'filled';
}

export function formatExecutionNumber(value: number): string {
    return Number(value.toFixed(12)).toString();
}

export function roundToPrecision(value: number, precision: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (!Number.isInteger(precision) || precision <= 0) return Math.round(value);
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

export function formatAmountWithPrecision(value: number, precision: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0';
    if (precision <= 0) return Math.floor(value).toString();
    const factor = Math.pow(10, precision);
    const normalized = Math.floor(value * factor) / factor;
    return normalized.toFixed(precision);
}

export function toPrecisionUnits(value: number, precision: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const safePrecision = Math.max(0, precision);
    const factor = Math.pow(10, safePrecision);
    return Math.floor(value * factor + 1e-9);
}

export function fromPrecisionUnits(units: number, precision: number): number {
    const safePrecision = Math.max(0, precision);
    const factor = Math.pow(10, safePrecision);
    return units / factor;
}

export function allocateAmountByDistribution(totalAmount: number, distribution: Array<number | string>, precision: number): number[] {
    const safeDist = distribution.map((r) => {
        const numeric = Number(r);
        return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
    });
    const totalUnits = toPrecisionUnits(totalAmount, precision);
    if (totalUnits <= 0 || safeDist.length === 0) return [];

    const allocatedUnits: number[] = Array(safeDist.length).fill(0);
    let remainingUnits = totalUnits;
    for (let i = 0; i < safeDist.length; i++) {
        if (i === safeDist.length - 1) {
            allocatedUnits[i] = Math.max(0, remainingUnits);
            break;
        }
        const candidate = Math.floor(totalUnits * safeDist[i]);
        const capped = Math.min(Math.max(0, candidate), remainingUnits);
        allocatedUnits[i] = capped;
        remainingUnits -= capped;
    }

    return allocatedUnits.map(units => fromPrecisionUnits(units, precision));
}

export async function delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}
