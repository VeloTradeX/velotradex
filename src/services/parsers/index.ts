import { IStrategyParser, ParsedStrategy } from './types';
import { DefaultParser } from './DefaultParser';
import logger from '../../utils/logger';
import { GaulsParser } from './GaulsParser';
import { AlwaysWinParser } from './AlwaysWinParser';
import { RaizexbtParser } from './RaizexbtParser';
import { WWGParser } from './WWGParser';
import { MansoorParser } from './MansoorParser';
import { KacangParser } from './KacangParser';

class StrategyParserRegistry {
  private parsers: Map<string, IStrategyParser> = new Map();

  constructor() {
    this.registerParser(new DefaultParser());
    this.registerParser(new AlwaysWinParser());
    this.registerParser(new RaizexbtParser());
    this.registerParser(new WWGParser());
    this.registerParser(new GaulsParser());
    this.registerParser(new MansoorParser());
    this.registerParser(new KacangParser());
  }

  public registerParser(parser: IStrategyParser) {
    this.parsers.set(parser.name, parser);
    logger.info(`Registered parser ${parser.name}`);
  }

  public getParserByName(name: string): IStrategyParser | null {
    return this.parsers.get(name) || null;
  }

  public getAllParsers(): { name: string; description?: string }[] {
    const result: { name: string; description?: string }[] = [];
    this.parsers.forEach((parser) => {
      result.push({ name: parser.name });
    });
    return result;
  }

  // Deprecated: Kept for backward compatibility if any old code still calls it
  public getParser(channelId?: string): IStrategyParser | null {
      return null;
  }
}

const registry = new StrategyParserRegistry();

export default registry;
export { DefaultParser };
export * from './types';
