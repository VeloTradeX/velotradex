import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(__dirname, '..');

function readParserSource(parserFile: string): string {
  return fs.readFileSync(path.join(ROOT_DIR, 'src', 'services', 'parsers', parserFile), 'utf8');
}

describe('vision parser prompt safeguards', () => {
  it('RaizexbtParser.ts tells the model not to confuse current price with limit entry', () => {
    const source = readParserSource('RaizexbtAiPrompts.ts');

    expect(source).toContain('current price marker');
    expect(source).toContain('NOT the entry price');
    expect(source).toContain('boundary between the take-profit colored zone and the stop-loss colored zone');
    expect(source).toContain('set entryPrice to null');
  });

  it('RaizexbtParser.ts includes symmetric long/short risk-reward box safeguards', () => {
    const source = readParserSource('RaizexbtAiPrompts.ts');

    expect(source).toContain('live/current price marker is only market context');
    expect(source).toContain('stopLoss > entryPrice > first target');
    expect(source).toContain('first target > entryPrice > stopLoss');
    expect(source).toContain('gray stop-loss zone above entry');
    expect(source).toContain('red take-profit zone below entry');
    expect(source).toContain('gray stop-loss zone below entry');
    expect(source).toContain('green take-profit zone above entry');
    expect(source).toContain('timer below it');
  });

  it('RaizexbtParser.ts tells the model to infer missing symbols from cached market prices instead of defaulting to BTC', () => {
    const source = readParserSource('RaizexbtAiPrompts.ts');

    expect(source).toContain('market_prices');
    expect(source).toContain('Do not default to BTC');
    expect(source).toContain('closest current price');
  });
});
