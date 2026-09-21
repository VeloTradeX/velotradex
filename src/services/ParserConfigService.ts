import { IStrategyParser, StrategyRiskConfig } from './parsers/types';
import ParserConfig from '../models/ParserConfig';
import logger, { formatError } from '../utils/logger';

export class ParserConfigService {
    private static instance: ParserConfigService;

    private constructor() {}

    public static getInstance(): ParserConfigService {
        if (!ParserConfigService.instance) {
            ParserConfigService.instance = new ParserConfigService();
        }
        return ParserConfigService.instance;
    }

    /**
     * Get the effective risk config for a parser.
     * Merges hardcoded defaults with DB overrides.
     */
    public async getEffectiveConfig(parserName: string, defaultConfig: StrategyRiskConfig): Promise<StrategyRiskConfig> {
        try {
            const dbConfigRecord = await ParserConfig.findOne({ where: { parserName } });
            
            if (!dbConfigRecord || !dbConfigRecord.config) {
                // No DB config, return default
                return defaultConfig;
            }

            const dbConfig = JSON.parse(dbConfigRecord.config);
            this.migrateRatioBased(dbConfig);

            // Merge: DB overrides Default
            const cleanDbConfig = Object.entries(dbConfig).reduce((acc, [key, value]) => {
                if (value !== null && value !== undefined && value !== '') {
                    // Special handling for numeric fields that might come as strings from DB JSON
                    // We need to check if the default config has this key as number
                    const k = key as keyof StrategyRiskConfig;
                    if (typeof defaultConfig[k] === 'number' && typeof value === 'string') {
                         acc[k] = parseFloat(value) as any;
                    } else if (Array.isArray(defaultConfig[k]) && typeof value === 'string') {
                         try {
                            acc[k] = JSON.parse(value);
                         } catch (e) {
                            acc[k] = value as any;
                         }
                    } else {
                         // Boolean handling
                         if (value === 'true') acc[k] = true as any;
                         else if (value === 'false') acc[k] = false as any;
                         else acc[k] = value as any;
                    }
                }
                return acc;
            }, {} as Partial<StrategyRiskConfig>);

            const effectiveConfig = {
                ...defaultConfig,
                ...cleanDbConfig
            };

            return effectiveConfig;

        } catch (error: any) {
            logger.error(`Failed to load config for parser ${parserName}`, formatError(error));
            return defaultConfig; // Fallback to safe default
        }
    }

    public async saveConfig(parserName: string, config: Partial<StrategyRiskConfig>) {
        try {
            const [record, created] = await ParserConfig.findOrCreate({
                where: { parserName },
                defaults: {
                    parserName,
                    config: JSON.stringify(config)
                }
            });

            if (!created) {
                record.config = JSON.stringify(config);
                await record.save();
            }
            
            logger.info(`Updated config for parser ${parserName}`);
            return record;
        } catch (error: any) {
            logger.error(`Failed to save config for parser ${parserName}`, formatError(error));
            throw error;
        }
    }
    
    public async getDbConfig(parserName: string): Promise<Partial<StrategyRiskConfig>> {
        const record = await ParserConfig.findOne({ where: { parserName } });
        if (record && record.config) {
            return JSON.parse(record.config);
        }
        return {};
    }

    /**
     * Migrate legacy positionSizingMode='ratio_based' to riskMode='ratio_based'.
     * Called when loading config from DB.
     */
    private migrateRatioBased(config: any): void {
        if (config.positionSizingMode === 'ratio_based') {
            config.riskMode = 'ratio_based';
            if (!config.riskValue || config.riskValue === 10) {
                // Old default was fixed/10 USDT; new default for ratio_based is multiplier=1
                config.riskValue = 1;
            }
            delete config.positionSizingMode;
        }
    }

    public validateConfig(config: any): string | null {
        // Basic validation
        if (config.riskMode && !['fixed', 'percentage', 'ratio_based'].includes(config.riskMode)) {
            return 'Invalid riskMode. Must be "fixed", "percentage", or "ratio_based".';
        }
        
        if (config.riskValue !== undefined) {
            const val = parseFloat(config.riskValue);
            if (isNaN(val) || val < 0) return 'riskValue must be a positive number.';
        }

        if (config.riskMode === 'ratio_based' && config.riskValue !== undefined) {
            const val = parseFloat(config.riskValue);
            if (isNaN(val) || val < 0.01 || val > 10) return 'riskValue for ratio_based mode must be between 0.01 and 10 (multiplier).';
        }

        if (config.positionSizingMode && !['risk_based', 'size_based'].includes(config.positionSizingMode)) {
            return 'Invalid positionSizingMode. Must be "risk_based" or "size_based".';
        }

        if (config.defaultLeverage !== undefined) {
            // leverage is string usually e.g. '10'
            const val = parseInt(config.defaultLeverage);
            if (isNaN(val) || val <= 0) return 'defaultLeverage must be a positive integer.';
        }
        
        if (config.priceTolerance !== undefined) {
            const val = parseFloat(config.priceTolerance);
            if (isNaN(val) || val < 0 || val > 0.5) return 'priceTolerance must be between 0 and 0.5 (50%).';
        }

        const paddingFields = ['entryPaddingR', 'tpPaddingR', 'slPaddingR'];
        for (const field of paddingFields) {
            if (config[field] !== undefined) {
                const val = parseFloat(config[field]);
                if (isNaN(val) || Math.abs(val) > 0.5) return `${field} absolute value must not exceed 0.5 (50%).`;
            }
        }

        if (config.paddingMode !== undefined && config.paddingMode !== null && config.paddingMode !== '' && config.paddingMode !== 'r' && config.paddingMode !== 'fixed') {
            return 'paddingMode must be "r" or "fixed".';
        }

        // 固定金额（美元）体系字段：非负有限数值
        const fixedOffsetFields = ['entryOffsetFixed', 'fixedSlDistance', 'slBackOffsetFixed'];
        for (const field of fixedOffsetFields) {
            if (config[field] !== undefined && config[field] !== null && config[field] !== '') {
                const val = parseFloat(config[field]);
                if (isNaN(val) || val < 0 || val > 1000000) return `${field} must be a number between 0 and 1000000.`;
            }
        }

        if (config.entrySelection !== undefined && config.entrySelection !== null && config.entrySelection !== '' && config.entrySelection !== 'all' && config.entrySelection !== 'nearest_sl') {
            return 'entrySelection must be "all" or "nearest_sl".';
        }
        
        if (config.entryMergeThresholdR !== undefined) {
            const val = parseFloat(config.entryMergeThresholdR);
            if (isNaN(val) || val < 0) return 'entryMergeThresholdR must be a number >= 0.';
        }

        if (config.tpOrderType && !['limit', 'market'].includes(config.tpOrderType)) {
             return 'tpOrderType must be "limit" or "market".';
        }

        if (config.tpOrderMode && !['maker', 'taker'].includes(config.tpOrderMode)) {
             return 'tpOrderMode must be "maker" or "taker".';
        }
        
        if (config.entryOrderMode && !['maker', 'taker'].includes(config.entryOrderMode)) {
             return 'entryOrderMode must be "maker" or "taker".';
        }

        if (config.tpDistribution) {
             if (!Array.isArray(config.tpDistribution)) return 'tpDistribution must be an array.';
             // Check sum? Maybe not strictly required to be 1, but useful.
        }

        return null; // Valid
    }
}

export default ParserConfigService.getInstance();
