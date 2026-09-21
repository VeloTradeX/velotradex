import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

async function updateMarketsFromAPI() {
  const response = await axios.get('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails');
  const markets = response.data.order_book_details;

  const config = markets
    .filter((m: any) => m.market_type === 'perp')
    .sort((a: any, b: any) => a.market_id - b.market_id)
    .map((m: any) => ({
      symbol: `${m.symbol}_USDT`,
      marketIndex: m.market_id,
      baseCurrency: m.symbol,
      quoteCurrency: 'USDC',
      priceDecimals: m.price_decimals,
      sizeDecimals: m.size_decimals,
      minBaseAmount: m.min_base_amount,
      multiplier: '1',
      leverageMin: '1',
      leverageMax: m.min_initial_margin_fraction === 1000 ? '10' : 
                   m.min_initial_margin_fraction === 2000 ? '5' : 
                   m.min_initial_margin_fraction === 3333 ? '3' : '10',
    }));

  const outputPath = path.join(__dirname, '../dict/lighter_markets.json');
  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2));
  console.log(`Updated ${config.length} markets to ${outputPath}`);
}

updateMarketsFromAPI().catch(console.error);
