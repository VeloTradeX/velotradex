# 说明

## Lighter Markets (`lighter_markets.json`)

Lighter 交易所的市场配置文件。如果数据库配置中未指定 markets，交易所会自动加载此文件。

### 结构说明

每个市场条目包含：

- `symbol`: 交易对符号（如 "BTC_USDT"）
- `marketIndex`: Lighter 内部市场索引
- `baseCurrency`: 基础货币（如 "BTC"）
- `quoteCurrency`: 报价货币（Lighter 上通常为 "USDC"）
- `priceDecimals`: 价格小数位数
- `sizeDecimals`: 订单数量小数位数
- `minBaseAmount`: 最小订单数量（基础货币）
- `multiplier`: 合约乘数（通常为 "1"）
- `leverageMin`: 最小杠杆（通常为 "1"）
- `leverageMax`: 最大杠杆

### 支持的市场（共 97 个）

#### 加密货币永续合约

**50倍杠杆**:
- BTC_USDT (marketIndex: 1)
- ETH_USDT (marketIndex: 2)

**25倍杠杆**:
- SOL_USDT (marketIndex: 3)

**20倍杠杆**:
- XRP_USDT, HYPE_USDT, BNB_USDT (marketIndex: 4-6)

**15倍杠杆**:
- ARB_USDT, OP_USDT (marketIndex: 7-8)

**10倍杠杆**:
- TON_USDT, BCH_USDT, ADA_USDT, DOGE_USDT, JUP_USDT, XMR_USDT, TRUMP_USDT, LDO_USDT, SEI_USDT, LTC_USDT, FARTCOIN_USDT, KSHIB_USDT, KBONK_USDT, IP_USDT, WIF_USDT, DOT_USDT, SUI_USDT, TIA_USDT, UNI_USDT, XPL_USDT, ENA_USDT, CRV_USDT, NEAR_USDT, KPEPE_USDT, WLD_USDT, APT_USDT, POPCAT_USDT, ONDO_USDT, AVAX_USDT, TRX_USDT, AAVE_USDT, LINK_USDT (marketIndex: 9-40)

**8倍杠杆**:
- POL_USDT, PUMP_USDT, ZK_USDT, PAXG_USDT, PENGU_USDT (marketIndex: 41-45)

**5倍杠杆**:
- PENDLE_USDT, TAO_USDT, PYTH_USDT, SPX_USDT, STRK_USDT, SYRUP_USDT, VIRTUAL_USDT, ICP_USDT, MNT_USDT, KAITO_USDT, APEX_USDT, GRASS_USDT, CC_USDT, BERA_USDT, ASTER_USDT, GMX_USDT, HBAR_USDT, ETHFI_USDT, MORPHO_USDT, EIGEN_USDT, MET_USDT, ZRO_USDT, DYDX_USDT, FIL_USDT, ZEC_USDT, S_USDT, YZY_USDT (marketIndex: 46-72)

**3倍杠杆**:
- VVV_USDT, DOLO_USDT, MYX_USDT, KTOSHI_USDT, ZORA_USDT, AERO_USDT, NMR_USDT, 2Z_USDT, AVNT_USDT, LINEA_USDT, USELESS_USDT, RESOLV_USDT, CRO_USDT, 0G_USDT, PROVE_USDT, EDEN_USDT, FF_USDT, STBL_USDT (marketIndex: 73-90)

#### 外汇永续合约（25倍杠杆）

- USDCHF_USDT (marketIndex: 91)
- USDCAD_USDT (marketIndex: 92)
- USDJPY_USDT (marketIndex: 93)
- EURUSD_USDT (marketIndex: 94)
- GBPUSD_USDT (marketIndex: 95)

#### 贵金属永续合约

- XAG_USDT (白银, 10倍杠杆, marketIndex: 96)
- XAU_USDT (黄金, 15倍杠杆, marketIndex: 97)

## Gate.io 合约信息

https://api.gateio.ws/api/v4/futures/usdt/contracts

