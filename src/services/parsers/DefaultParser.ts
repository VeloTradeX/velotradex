import { IStrategyParser, ParsedStrategy, StrategyRiskConfig } from './types';
import logger, { formatError } from '../../utils/logger';

export class DefaultParser implements IStrategyParser {
  name = 'DefaultParser';

  public getRiskConfig(): StrategyRiskConfig {
    return {
      riskMode: 'percentage',
      riskValue: 5, // 5% default risk
      defaultLeverage: '5',
      priceTolerance: 0.01, // 0.01R (1% of R value)
      entryOrderMode: 'taker',
      autoCloseOppositePosition: false, // Default: Do not auto-close opposite positions
    };
  }

  public async parse(message: any): Promise<ParsedStrategy[] | null> {
    logger.debug('Parsing message with default parser', { message });

    try {
      // Basic validation
      if (!message.symbol || !message.side) {
        // logger.warn('Invalid message format for DefaultParser', { message });
        return null;
      }

      return [{
        action: 'open',
        symbol: message.symbol.toUpperCase(),
        side: message.side.toLowerCase(),
        entryPrice: message.entry || message.price,
        targets: message.targets || [],
        stopLoss: message.stopLoss,
        raw: message,
      }];
    } catch (error: any) {
      logger.error('Error parsing strategy in DefaultParser', formatError(error));
      return null;
    }
  }
}
