# 免责声明 / Disclaimer

> 本文件是 [README](README.md) 的组成部分。下载、安装、部署、运行或以任何方式使用
> 本项目（以下简称"本软件"），即视为你已阅读、理解并同意本声明全部内容。
> 如果你不同意其中任何一条，请立即停止使用并删除本软件。

本项目是一个**技术工具**，用于接收、解析交易信号并在交易所执行下单。
它**不提供**任何投资建议、交易建议、财务建议或收益承诺。

---

## 一、交易风险

1. **可能损失全部本金。** 加密货币、合约、杠杆、差价合约（CFD）、外汇等交易具有极高
   风险。价格波动、杠杆放大、强平（爆仓）、滑点、点差、资金费率与手续费都可能导致
   你损失全部甚至超过账户余额的资金（在允许穿仓的平台上）。
2. **不保证盈利。** 本项目不承诺任何收益率、胜率或回本能力。模拟盘
   （`virtual_*` / `testnet`）的表现**不代表**真实盘表现，二者在流动性、滑点、
   成交速度、手续费与市场冲击上存在本质差异。
3. **软件可能出错。** 本软件可能因程序缺陷、配置错误、网络中断、交易所接口变更、
   限频、行情/WebSocket 断连、时间不同步、数据库损坏、AI 解析误判等原因产生错误信号、
   错误仓位、重复下单、漏单、无法平仓或止盈止损失效。**任何自动交易系统都不能替代
   人工监控。**
4. **第三方风险。** 交易所、行情源、代理、AI 服务、Redis、云服务商等第三方均可能
   故障、变更条款、冻结资金或倒闭，由此造成的损失由使用者自行承担。
5. **默认配置并非安全配置。** 本软件默认以 `TRADING_MODE=observe`（仅解析不下单）运行。
   切换为 `testnet` / `real` 前，你**必须**自行完成风控校验、参数核对与小资金验证。

## 二、信号来源的合法合规性（重要）

本软件本身**不附带、不提供、也不授权**任何交易信号内容。所有信号由你自行接入，
你对接入的信号及其来源负全部责任。请务必确认：

1. **合法获取。** 你接入的信号必须是你**合法获得**的，例如：你自有的策略、你已获
   明确授权的信号源，或公开许可允许你使用的内容。
2. **禁止使用未经授权抓取的内容。** **不得**将通过爬取、逆向、绕过权限等方式从
   Discord、Telegram、付费社群、VIP 频道、订阅服务等获取的**他人付费或私有信号**
   接入本系统，尤其不得用于转发、分发、二次销售或再发布。此类行为可能同时违反
   版权法、平台服务条款以及你与信号提供方之间的协议，并可能构成不正当竞争或侵权。
3. **取得必要授权。** 若信号来自第三方，你应确保已获得该信号提供方**明确、有效**的
   授权（包括是否允许自动化消费、下单与再分发），并遵守其服务条款。
4. **遵守平台规则。** 你的接入方式须遵守相关平台（如 Discord、Telegram）的服务条款，
   包括但不限于禁止未经许可的抓取、机器人滥用与内容再分发。
5. **不得用于操纵市场。** 不得利用本软件进行幌骗（spoofing）、拉抬打压、刷量、
   内幕交易、市场操纵或其他违法违规交易行为。
6. **遵守当地法律。** 你须自行确保信号的获取、使用与自动化交易行为符合你所在
   司法辖区的法律、法规与监管要求。
7. **不侵犯他人权利。** 请勿在本项目中提交、存储或分发任何第三方的版权内容、
   商业秘密、个人信息或真实交易数据。本仓库 `examples/` 目录下的全部数据均为
   人工编写的虚构示例。

**因信号来源不合法、不合规或未经授权而产生的一切后果，由使用者自行承担，
本项目作者与贡献者不承担任何责任。**

## 三、法律与监管合规

1. 自动交易、程序化交易、跟单交易、加密资产及相关衍生品在**不同国家和地区**可能
   受到不同监管，甚至被禁止。
2. 你须自行确认并遵守所在司法辖区的法律法规，包括但不限于：交易许可、
   税务申报、反洗钱（AML）、了解你的客户（KYC）、外汇管制与衍生品交易限制。
3. 你须自行判断是否需要向监管机构报备或取得相应资质。
4. 本项目作者与贡献者不构成你的投资顾问、经纪商或受托人，与你之间不存在任何
   投资顾问、信托或代理关系。

## 四、无担保

本软件按 **"现状"（AS IS）** 与 **"现有"（AS AVAILABLE）** 提供，不附带任何形式的
明示或默示担保，包括但不限于对适销性、特定用途适用性、准确性、可靠性、
不侵权、无中断或无错误的担保。详见 [LICENSE](LICENSE)（MIT）。

## 五、责任限制

在适用法律允许的最大范围内，本项目作者与贡献者**不对**因使用或无法使用本软件而
产生的任何直接、间接、附带、特殊、惩罚性或后果性损害承担责任，包括但不限于
资金损失、利润损失、数据丢失、交易失败、账户被冻结或任何其他损失，
**即使已被告知发生此类损害的可能性**。

## 六、你的责任

使用本软件即表示你确认并同意：

- 你已充分理解自动交易的风险，并**自行承担全部交易后果**；
- 你已确保所接入信号的来源**合法合规**且已获得必要授权；
- 你会在**真实资金**投入前，先在 `observe` / `testnet` / 小资金环境完成充分验证；
- 你会持续监控系统运行，并自行配置止损、仓位上限等风控措施；
- 你对因自身配置错误、密钥泄露、信号来源问题或违反法律法规所造成的后果负责。

---

## English Summary

This project is a **tool**, not financial advice. Automated trading is extremely risky and
you may lose all of your funds. Simulated results do **not** guarantee live
results. The software is provided "AS IS" without warranty of any kind.

**You are solely responsible for the signals you feed into this system.** Do **not** ingest
signals that were scraped, bypassed, or otherwise obtained without authorization — including
paid or private signals from Discord, Telegram, VIP groups, or subscription services.
Ensure you have explicit permission to use any third-party signal, comply with all platform
terms of service and applicable laws, and never use this software for market manipulation or
any illegal activity. The authors and contributors accept **no liability** for any loss or
damage arising from the use of this software or from non-compliant signal sources.
