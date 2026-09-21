<template>
  <el-dialog
    v-model="visible"
    :title="isEdit ? '编辑路由' : '添加路由'"
    width="1000px"
    top="3vh"
    class="route-edit-dialog"
  >
    <el-form :model="form" label-width="130px" ref="formRef" :rules="rules" class="route-edit-form">
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="名称" prop="name">
            <el-input v-model="form.name" placeholder="例如: Ken 信号 -> Gate 主" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="频道 ID" prop="channelId">
            <el-input v-model="form.channelId" placeholder="Discord 频道 ID" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="目标交易所" prop="exchangeInstanceId">
            <el-select v-model="form.exchangeInstanceId" placeholder="选择交易所实例" style="width: 100%" @change="handleExchangeChange">
              <el-option v-for="ex in exchanges" :key="ex.id" :label="`${ex.name} (${ex.id})`" :value="ex.id">
                <div class="option-with-logo">
                  <ExchangeLogo :type="ex.type" size="sm" />
                  <span class="name-text">{{ ex.name }}</span>
                  <span style="margin-left:auto;color:#999;font-size:12px;">({{ ex.id }})</span>
                </div>
              </el-option>
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="解析器" prop="parser">
            <el-select v-model="form.parser" placeholder="选择解析器" style="width: 100%">
              <el-option v-for="p in parsers" :key="p.name" :label="p.name" :value="p.name" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="AI 解析模式" prop="aiMode">
            <el-select v-model="form.aiMode" placeholder="AI 模式" style="width: 100%">
              <el-option label="禁用 (Disabled)" value="disabled" />
              <el-option label="仅分析 (Analyze Only)" value="analyze_only" />
              <el-option label="启用 (Enabled)" value="enabled" />
            </el-select>
            <div class="form-tip">启用后，AI 分析结果将优先于程序解析结果。</div>
          </el-form-item>
        </el-col>
      </el-row>

      <el-divider content-position="left">风控覆盖配置 (可选)</el-divider>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="风险模式" prop="riskSettings.riskMode">
            <el-select v-model="form.riskSettings.riskMode" placeholder="默认" style="width: 100%">
              <el-option label="使用默认" value="" />
              <el-option label="百分比 (Percentage)" value="percentage" />
              <el-option label="固定金额 (Fixed)" value="fixed" />
              <el-option label="比例跟随 (Ratio Based)" value="ratio_based" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="风险值" prop="riskSettings.riskValue">
            <el-input v-model="form.riskSettings.riskValue" :placeholder="riskValuePlaceholder" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24" v-if="form.riskSettings.riskMode !== 'ratio_based'">
        <el-col :span="12">
          <el-form-item label="仓位分配模式" prop="riskSettings.positionSizingMode">
            <el-select v-model="form.riskSettings.positionSizingMode" placeholder="默认" style="width: 100%">
              <el-option label="使用默认" value="" />
              <el-option label="风险等分 (Risk Based)" value="risk_based" />
              <el-option label="仓位等分 (Size Based)" value="size_based" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="反向自动平仓" prop="riskSettings.autoCloseOppositePosition">
            <el-select v-model="form.riskSettings.autoCloseOppositePosition" placeholder="默认" style="width: 100%">
              <el-option label="使用默认" :value="undefined" />
              <el-option label="开启 (True)" :value="true" />
              <el-option label="关闭 (False)" :value="false" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item prop="riskSettings.syncCfdPrice">
            <template #label>
              <span class="form-label-with-tip">
                跟 CFD 价格同步
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>跟 CFD 价格同步 (syncCfdPrice)</strong><br/>
                      <br/>
                      <strong>说明：</strong><br/>
                      • 开启后，该路由的执行/撮合价格与 Gate CFD 行情同步<br/>
                      • 默认不同步<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      虚拟撮合场景下，订单按 CFD 最新价成交
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-select v-model="form.riskSettings.syncCfdPrice" style="width: 100%">
              <el-option label="不同步 (默认)" :value="false" />
              <el-option label="同步" :value="true" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="入场模式" prop="riskSettings.entryOrderMode">
            <el-select v-model="form.riskSettings.entryOrderMode" placeholder="默认 (Taker)" style="width: 100%">
              <el-option label="使用默认 (Taker)" :value="undefined" />
              <el-option label="挂单 (Maker)" value="maker" />
              <el-option label="吃单 (Taker)" value="taker" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="杠杆倍数" prop="riskSettings.defaultLeverage">
            <el-input v-model="form.riskSettings.defaultLeverage" placeholder="例如: 10" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="最大持仓(U)" prop="riskSettings.maxPositionSize">
            <el-input v-model="form.riskSettings.maxPositionSize" placeholder="例如: 1000" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item prop="riskSettings.priceTolerance">
            <template #label>
              <span class="form-label-with-tip">
                价格容忍度
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>价格容忍度 (priceTolerance)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 决定何时使用市价单而非限价单入场<br/>
                      • 以R值的倍数计算，如0.01表示0.01R<br/>
                      • R = |入场价 - 止损价|，表示风险单位<br/>
                      <br/>
                      <strong>判断逻辑：</strong><br/>
                      • 做多：当前价 > 入场价 + 容忍度时，使用市价单<br/>
                      • 做空：当前价 < 入场价 - 容忍度时，使用市价单<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      入场价80000，止损79000，R=1000<br/>
                      容忍度0.01R = 10 USDT<br/>
                      做多时，当前价>80010就用市价单
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.riskSettings.priceTolerance" placeholder="例如: 0.01 (0.01R)" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item prop="riskSettings.entryPaddingR">
            <template #label>
              <span class="form-label-with-tip">
                入场滑点(R)
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>入场滑点 (entryPaddingR)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 调整入场价格以提高成交概率<br/>
                      • 以R值的倍数计算，如0.01表示0.01R<br/>
                      • R = |入场价 - 止损价|，表示风险单位<br/>
                      <br/>
                      <strong>调整方向：</strong><br/>
                      • 做多：入场价向上调整(买贵一点确保成交)<br/>
                      • 做空：入场价向下调整(卖便宜一点确保成交)<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      原入场价80000，止损79000，R=1000<br/>
                      滑点0.01R = 10 USDT<br/>
                      做多调整后入场价：80010
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.riskSettings.entryPaddingR" placeholder="例如: 0.01" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item prop="riskSettings.tpPaddingR">
            <template #label>
              <span class="form-label-with-tip">
                TP滑点(R)
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>止盈滑点 (tpPaddingR)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 调整止盈价格以提高成交概率<br/>
                      • 以R值的倍数计算，如0.01表示0.01R<br/>
                      • R = |入场价 - 止损价|，表示风险单位<br/>
                      <br/>
                      <strong>调整方向：</strong><br/>
                      • 做多：止盈价向下调整(卖便宜一点确保成交)<br/>
                      • 做空：止盈价向上调整(买贵一点确保成交)<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      原止盈价81000，止损79000，R=1000<br/>
                      滑点0.01R = 10 USDT<br/>
                      做多调整后止盈价：80990
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.riskSettings.tpPaddingR" placeholder="例如: 0.01" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item prop="riskSettings.slPaddingR">
            <template #label>
              <span class="form-label-with-tip">
                SL滑点(R)
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>止损滑点 (slPaddingR)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 调整止损价格以提供安全缓冲<br/>
                      • 以R值的倍数计算，如0.01表示0.01R<br/>
                      • R = |入场价 - 止损价|，表示风险单位<br/>
                      <br/>
                      <strong>调整方向：</strong><br/>
                      • 做多：止损价向下调整(提供更多缓冲空间)<br/>
                      • 做空：止损价向上调整(提供更多缓冲空间)<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      原止损价79000，入场价80000，R=1000<br/>
                      滑点0.01R = 10 USDT<br/>
                      做多调整后止损价：78990
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.riskSettings.slPaddingR" placeholder="例如: 0.01" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item prop="riskSettings.paddingMode">
            <template #label>
              <span class="form-label-with-tip">
                价格调整体系
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>价格调整体系 (paddingMode)</strong><br/>
                      <br/>
                      <strong>说明：</strong><br/>
                      • 两套互斥的入场/止损价格调整体系，不会叠加生效<br/>
                      • R百分比(R)：按 R 倍数调整（上面的入场滑点/TP滑点/SL滑点字段）<br/>
                      • 固定金额(Fixed)：按固定美元调整（让点入场/固定止损距离/止损后移字段）<br/>
                      <br/>
                      <strong>适用场景：</strong><br/>
                      止盈止损距离较紧密的策略，按 R 百分比无法精确控制时，改用固定金额体系<br/>
                      <br/>
                      <strong>注意：</strong><br/>
                      • 选择「固定金额」后，上面的 R 滑点字段（入场/TP/SL）全部不生效<br/>
                      • 留空 = 默认 R 百分比体系
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-select v-model="form.riskSettings.paddingMode" placeholder="默认 (R百分比)" style="width: 100%">
              <el-option label="使用默认 (R百分比)" :value="undefined" />
              <el-option label="R百分比 (R)" value="r" />
              <el-option label="固定金额 (Fixed)" value="fixed" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item prop="riskSettings.entrySelection">
            <template #label>
              <span class="form-label-with-tip">
                入场点选择
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>入场点选择 (entrySelection)</strong><br/>
                      <br/>
                      <strong>说明：</strong><br/>
                      • 控制多入场点信号的入场方式<br/>
                      • 全部入场(all)：默认行为，所有入场点按权重均分仓位（各 1/N）<br/>
                      • 仅最靠近止损的入场点(nearest_sl)：跳过其他入场点，仓位全部打到与止损价距离最近的那个入场点（该点权重=1 全仓）<br/>
                      <br/>
                      <strong>判断规则：</strong><br/>
                      • 「最近」= 入场价与止损价的绝对距离最小<br/>
                      • 做多时通常是更低的入场点，做空时通常是更高的入场点（更靠近止损）<br/>
                      • 市价/CMP 入场点无价格，不参与比较（会被跳过）<br/>
                      • 单入场点信号不受影响，正常入场<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      做多信号：入场点1=2650，入场点2=2648，SL=2640<br/>
                      选 nearest_sl → 只在 2648 入场（距SL 8 &lt; 距SL 10），全仓
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-select v-model="form.riskSettings.entrySelection" placeholder="默认 (全部入场)" style="width: 100%">
              <el-option label="使用默认 (全部入场)" :value="undefined" />
              <el-option label="全部入场 (All)" value="all" />
              <el-option label="仅最靠近止损的入场点 (Nearest SL)" value="nearest_sl" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24" v-if="form.riskSettings.paddingMode === 'fixed'">
        <el-col :span="8">
          <el-form-item prop="riskSettings.entryOffsetFixed">
            <template #label>
              <span class="form-label-with-tip">
                让点入场($)
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>让点提前入场 (entryOffsetFixed)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 把入场价向有利方向移动固定美元，提前挂单成交<br/>
                      • 做多：入场价 − X（挂更低的限价买单，价格回落时先于信号价成交）<br/>
                      • 做空：入场价 + X（挂更高的限价卖单）<br/>
                      • 所有入场点共享同一个值<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      做多信号入场价 2650，让点 1.5<br/>
                      实际挂单入场价：2648.5<br/>
                      <br/>
                      <strong>注意：</strong><br/>
                      • 仅在「价格调整体系=固定金额」时生效<br/>
                      • 留空 = 不让点
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.riskSettings.entryOffsetFixed" placeholder="例如: 1.5 (让1.5美元)" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item prop="riskSettings.fixedSlDistance">
            <template #label>
              <span class="form-label-with-tip">
                固定止损距离($)
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>固定止损距离 (fixedSlDistance)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 忽略信号自带止损价，改为固定美元距离<br/>
                      • 做多：SL = 入场价 − X；做空：SL = 入场价 + X<br/>
                      • 基准为让点后的实际入场价<br/>
                      • 比信号止损更近 = 提前止损（亏得更少）；更远 = 给更多波动空间<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      做多入场价 2650（让点后 2648.5），固定止损距离 5<br/>
                      实际止损价：2648.5 − 5 = 2643.5<br/>
                      <br/>
                      <strong>注意：</strong><br/>
                      • 仅在「价格调整体系=固定金额」时生效<br/>
                      • 留空 = 使用信号自带止损<br/>
                      • 调整后止损若穿越当前价会被拒单（避免成交即止损）
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.riskSettings.fixedSlDistance" placeholder="例如: 5 (固定5美元止损)" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item prop="riskSettings.slBackOffsetFixed">
            <template #label>
              <span class="form-label-with-tip">
                止损后移($)
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>止损后移 (slBackOffsetFixed)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 把止损价向远离价格的方向拖后固定美元（拖后止损）<br/>
                      • 做多：SL − X；做空：SL + X<br/>
                      • 在固定止损距离（若配置）的结果之上叠加<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      做多信号止损 2640，止损后移 1.5<br/>
                      实际止损价：2640 − 1.5 = 2638.5<br/>
                      <br/>
                      <strong>注意：</strong><br/>
                      • 仅在「价格调整体系=固定金额」时生效<br/>
                      • 留空 = 不后移
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input v-model="form.riskSettings.slBackOffsetFixed" placeholder="例如: 1.5 (后移1.5美元)" />
          </el-form-item>
        </el-col>
      </el-row>
      <div v-if="form.riskSettings.paddingMode === 'fixed'" class="form-tip" style="margin: -8px 0 12px;">
        固定金额体系已启用：上方「入场滑点(R)/TP滑点(R)/SL滑点(R)」不生效；入场与止损价将按上方固定美元参数调整。
      </div>

      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item prop="riskSettings.fixedRiskRewardClose">
            <template #label>
              <span class="form-label-with-tip">
                固定RR平仓
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>固定盈亏比平仓 (fixedRiskRewardClose)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 设置后，会在策略TP目标后追加一个固定RR的平仓目标<br/>
                      • 例如: 1.3 表示在1.3R位置追加一个平仓点<br/>
                      • R = |入场价 - 止损价|，表示风险单位<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      入场价80000，止损79000，R=1000<br/>
                      设置1.3 → 追加TP价格：81300<br/>
                      <br/>
                      <strong>注意：</strong><br/>
                      • 留空 = 使用解析器默认值<br/>
                      • 设为0 = 显式禁用固定RR平仓
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input
              v-model="form.riskSettings.fixedRiskRewardClose"
              placeholder="例如: 1.3 (1.3R平仓) 或 0 (禁用)"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="24" v-if="supportsEntryMerge">
        <el-col :span="12">
          <el-form-item prop="riskSettings.entryMergeThresholdR">
            <template #label>
              <span class="form-label-with-tip">
                合并阈值(R)
                <el-tooltip effect="dark" placement="top" raw-content>
                  <template #content>
                    <div style="max-width: 300px;">
                      <strong>入场点合并阈值 (entryMergeThresholdR)</strong><br/>
                      <br/>
                      <strong>工作原理：</strong><br/>
                      • 当两个入场点间距小于此值 × R 时，合并为一个入场点<br/>
                      • R = |入场价 - 止损价|，表示风险单位<br/>
                      • 合并后保留更接近当前价的入场点<br/>
                      <br/>
                      <strong>示例：</strong><br/>
                      入场价1=80000，入场价2=79995，止损=79000<br/>
                      R=1000，阈值0.2R=200<br/>
                      间距=5 < 200 → 合并
                    </div>
                  </template>
                  <el-icon class="tip-icon"><QuestionFilled /></el-icon>
                </el-tooltip>
              </span>
            </template>
            <el-input
              v-model="form.riskSettings.entryMergeThresholdR"
              placeholder="例如: 0.2 (留空使用默认值)"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <el-divider content-position="left">支持交易对配置</el-divider>

      <el-form-item label="支持交易对" prop="supportedSymbols">
        <div style="width: 100%;">
          <div style="display: flex; gap: 10px; margin-bottom: 8px; align-items: center;">
            <el-button size="small" @click="handleSelectAllSymbols">全选</el-button>
            <el-button size="small" @click="handleClearSymbols">清空</el-button>
            <span class="form-tip" v-if="markets.length > 0">共 {{ markets.length }} 个交易对</span>
          </div>
          <div class="symbol-checkbox-wrap">
            <el-checkbox-group v-model="form.supportedSymbols">
              <el-checkbox v-for="m in markets" :key="m.symbol" :label="m.symbol" class="symbol-checkbox-item">
                {{ m.symbol }}
              </el-checkbox>
            </el-checkbox-group>
            <div v-if="markets.length === 0" class="empty-state">
              请先选择交易所或该交易所无数据
            </div>
          </div>
        </div>
      </el-form-item>

      <div v-if="form.supportedSymbols.length > 0">
        <el-divider content-position="left">交易对独立风控配置 (可选)</el-divider>
        <div class="symbol-settings-header">
          <span class="form-tip">仅需配置与全局风险值不同的交易对。留空则使用全局设置。</span>
          <el-input v-model="searchSymbol" placeholder="搜索交易对" style="width: 220px;" size="default" clearable />
        </div>
        <el-table :data="symbolSettingsList" size="default" border style="width: 100%" height="260" class="symbol-settings-table">
          <el-table-column prop="symbol" label="交易对" width="200" />
          <el-table-column label="风险值 (Risk Value)">
            <template #default="scope">
              <el-input :model-value="scope.row.riskValue" placeholder="默认 (继承全局)" size="default" @input="(val: string) => updateSymbolSetting(scope.row.symbol, val)">
                <template #append v-if="isPercentageMode">%</template>
              </el-input>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-form>
    <template #footer>
      <span class="dialog-footer">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { QuestionFilled } from '@element-plus/icons-vue'
import request from '../utils/request'

const props = defineProps<{
  modelValue: boolean
  editingRoute: any | null
  exchanges: any[]
  parsers: any[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const submitting = ref(false)
const formRef = ref()
const isEdit = ref(false)
const currentId = ref<number | null>(null)
const markets = ref<any[]>([])
const marketsLoading = ref(false)
const searchSymbol = ref('')

const form = reactive({
  name: '',
  channelId: '',
  exchangeInstanceId: '',
  parser: 'TheLabKenParser', // Default
  isActive: true,
  aiMode: 'disabled',
  supportedSymbols: [] as string[],
  riskSettings: {
    riskMode: '',
    riskValue: '',
    defaultLeverage: '',
    priceTolerance: '',
    maxPositionSize: '',
    entryPaddingR: '',
    tpPaddingR: '',
    slPaddingR: '',
    paddingMode: undefined,
    entryOffsetFixed: '',
    fixedSlDistance: '',
    slBackOffsetFixed: '',
    entrySelection: undefined,
    positionSizingMode: '',
    autoCloseOppositePosition: undefined,
    syncCfdPrice: false,
    entryOrderMode: undefined,
    tpOrderMode: undefined,
    fixedRiskRewardClose: '',
    entryMergeThresholdR: ''
  },
  symbolSpecificSettings: {} as Record<string, { riskValue: string }>
})

const rules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  channelId: [{ required: true, message: '请输入频道ID', trigger: 'blur' }],
  exchangeInstanceId: [{ required: true, message: '请选择交易所', trigger: 'change' }],
  parser: [{ required: true, message: '请选择解析器', trigger: 'change' }]
}

const isPercentageMode = computed(() => {
  return form.riskSettings.riskMode === 'percentage'
})

const riskValuePlaceholder = computed(() => {
  const mode = form.riskSettings.riskMode
  if (mode === 'ratio_based') return '例如: 1 (1倍) 或 2 (2倍)'
  if (mode === 'percentage') return '例如: 2 (2%)'
  if (mode === 'fixed') return '例如: 50 (USDT)'
  return '例如: 2 (2%) 或 50 (USDT)'
})

const currentParserRiskConfig = computed(() => {
  const p = props.parsers.find((p: any) => p.name === form.parser)
  return p?.riskConfig ?? null
})

const supportsEntryMerge = computed(() => {
  return currentParserRiskConfig.value?.entryMergeThresholdR != null
})

const symbolSettingsList = computed(() => {
  let list = form.supportedSymbols.map(symbol => {
    const setting = form.symbolSpecificSettings[symbol] || { riskValue: '' }
    return {
      symbol,
      riskValue: setting.riskValue || ''
    }
  })

  // Sort: configured first, then symbol
  list.sort((a, b) => {
    const hasA = a.riskValue !== '' && a.riskValue !== null
    const hasB = b.riskValue !== '' && b.riskValue !== null

    if (hasA && !hasB) return -1
    if (!hasA && hasB) return 1
    return a.symbol.localeCompare(b.symbol)
  })

  if (searchSymbol.value) {
    const q = searchSymbol.value.toUpperCase()
    list = list.filter(item => item.symbol.toUpperCase().includes(q))
  }

  return list
})

const updateSymbolSetting = (symbol: string, value: string) => {
  if (!form.symbolSpecificSettings[symbol]) {
    form.symbolSpecificSettings[symbol] = { riskValue: '' }
  }
  form.symbolSpecificSettings[symbol].riskValue = value
}

const resetRiskSettings = () => {
  form.riskSettings = {
    riskMode: '',
    riskValue: '',
    defaultLeverage: '',
    priceTolerance: '',
    maxPositionSize: '',
    entryPaddingR: '',
    tpPaddingR: '',
    slPaddingR: '',
    paddingMode: undefined,
    entryOffsetFixed: '',
    fixedSlDistance: '',
    slBackOffsetFixed: '',
    entrySelection: undefined,
    positionSizingMode: '',
    autoCloseOppositePosition: undefined,
    syncCfdPrice: false,
    entryOrderMode: undefined,
    tpOrderMode: undefined,
    fixedRiskRewardClose: '',
    entryMergeThresholdR: ''
  }
}

const populateAdd = () => {
  isEdit.value = false
  currentId.value = null
  searchSymbol.value = ''
  form.name = ''
  form.channelId = ''
  form.exchangeInstanceId = ''
  form.parser = 'TheLabKenParser' // Default
  form.isActive = true
  form.aiMode = 'disabled'
  form.supportedSymbols = []
  markets.value = []
  resetRiskSettings()
  form.symbolSpecificSettings = {}
}

const populateEdit = (row: any) => {
  isEdit.value = true
  currentId.value = row.id
  searchSymbol.value = ''
  form.name = row.name
  form.channelId = row.channelId
  form.exchangeInstanceId = row.exchangeInstanceId
  form.parser = row.parser || 'TheLabKenParser'
  form.isActive = row.isActive
  form.aiMode = row.aiMode || 'disabled'

  // Parse supportedSymbols (handle potential double-encoding)
  try {
    let symbols = row.supportedSymbols ? JSON.parse(row.supportedSymbols) : []
    if (typeof symbols === 'string') {
      symbols = JSON.parse(symbols)
    }
    form.supportedSymbols = Array.isArray(symbols) ? symbols : []
  } catch (e) {
    form.supportedSymbols = []
  }

  // Load markets for the selected exchange
  if (form.exchangeInstanceId) {
    fetchMarkets(form.exchangeInstanceId)
  } else {
    markets.value = []
  }

  resetRiskSettings()

  if (row.riskSettings) {
    try {
      const settings = typeof row.riskSettings === 'string' ? JSON.parse(row.riskSettings) : row.riskSettings
      if (settings && settings.tpOrderMode === undefined && typeof settings.tpPostOnly === 'boolean') {
        settings.tpOrderMode = settings.tpPostOnly ? 'maker' : 'taker'
      }
      if (settings && Object.prototype.hasOwnProperty.call(settings, 'tpPostOnly')) {
        delete settings.tpPostOnly
      }
      // Normalize fixedRiskRewardClose: null → '' (empty = use default / disabled)
      if (settings && settings.fixedRiskRewardClose === null) {
        settings.fixedRiskRewardClose = ''
      }
      Object.assign(form.riskSettings, settings)
    } catch (e) {}
  }

  // Load Symbol Specific Settings
  form.symbolSpecificSettings = {}
  if (row.symbolSpecificSettings) {
    try {
      const settings = typeof row.symbolSpecificSettings === 'string' ? JSON.parse(row.symbolSpecificSettings) : row.symbolSpecificSettings
      form.symbolSpecificSettings = settings || {}
    } catch (e) {}
  }
}

const fetchMarkets = async (exchangeId: string) => {
  marketsLoading.value = true
  try {
    // Check if it's a Lighter exchange
    const exchange = props.exchanges.find(e => e.id === exchangeId)
    const isLighter = exchange && exchange.type === 'lighter'

    let res
    if (isLighter) {
      // Load from dict for Lighter exchanges
      res = await request.get('/exchanges/dict/lighter_markets')
    } else {
      // Load from exchange instance for other exchanges
      res = await request.get(`/exchanges/${exchangeId}/markets`)
    }

    // Sort markets: Priority coins first
    const priority = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']
    markets.value = res.data.sort((a: any, b: any) => {
      const getPriority = (symbol: string) => {
        const s = symbol.toUpperCase()
        // Match exact or starts with (e.g. BTC_USDT)
        const idx = priority.findIndex(p => s === p || s.startsWith(p + '_') || s.startsWith(p + '-'))
        return idx === -1 ? 999 : idx
      }

      const pA = getPriority(a.symbol)
      const pB = getPriority(b.symbol)

      if (pA !== pB) return pA - pB
      return a.symbol.localeCompare(b.symbol)
    })
  } catch (e: any) {
    ElMessage.error('获取交易对失败')
  } finally {
    marketsLoading.value = false
  }
}

const handleExchangeChange = (val: string) => {
  form.supportedSymbols = []
  if (val) {
    fetchMarkets(val)
  } else {
    markets.value = []
  }
}

const handleSelectAllSymbols = () => {
  form.supportedSymbols = markets.value.map(m => m.symbol)
}

const handleClearSymbols = () => {
  form.supportedSymbols = []
}

const submitForm = async () => {
  if (!formRef.value) return
  await formRef.value.validate(async (valid: boolean) => {
    if (!valid) return

    // Clean up risk settings (remove empty strings)
    const riskSettings: any = {}
    for (const [key, value] of Object.entries(form.riskSettings)) {
      if (value !== '' && value !== null && value !== undefined) {
        // fixedRiskRewardClose: 0 → null (explicitly disable)
        if (key === 'fixedRiskRewardClose') {
          const num = Number(value)
          if (num === 0) {
            riskSettings[key] = null
          } else if (!isNaN(num) && num > 0) {
            riskSettings[key] = num
          }
        // Convert numbers
        } else if (['riskValue', 'priceTolerance', 'maxPositionSize', 'entryPaddingR', 'tpPaddingR', 'slPaddingR', 'entryMergeThresholdR', 'entryOffsetFixed', 'fixedSlDistance', 'slBackOffsetFixed'].includes(key)) {
          riskSettings[key] = Number(value)
        } else {
          riskSettings[key] = value
        }
      }
    }

    // Clean up symbol specific settings
    const symbolSpecificSettings: Record<string, any> = {}
    for (const symbol of form.supportedSymbols) {
      const setting = form.symbolSpecificSettings[symbol]
      if (setting && setting.riskValue !== '' && setting.riskValue !== null && setting.riskValue !== undefined) {
        const val = Number(setting.riskValue)
        if (!isNaN(val)) {
          symbolSpecificSettings[symbol] = { riskValue: val }
        }
      }
    }

    const payload = {
      name: form.name,
      channelId: form.channelId,
      exchangeInstanceId: form.exchangeInstanceId,
      parser: form.parser,
      isActive: form.isActive,
      aiMode: form.aiMode,
      riskSettings,
      supportedSymbols: form.supportedSymbols, // Send as array, do not double-stringify
      symbolSpecificSettings
    }

    submitting.value = true
    try {
      if (isEdit.value && currentId.value) {
        await request.put(`/routes/${currentId.value}`, payload)
      } else {
        await request.post('/routes', payload)
      }
      ElMessage.success(isEdit.value ? '更新成功' : '创建成功')
      visible.value = false
      emit('saved')
    } catch (e: any) {
      ElMessage.error(e.message)
    } finally {
      submitting.value = false
    }
  })
}

// 打开弹窗时根据 editingRoute 决定新增/编辑填充，等价于原 handleAdd/handleEdit
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      if (props.editingRoute) populateEdit(props.editingRoute)
      else populateAdd()
    }
  }
)
</script>

<style scoped>
.route-edit-dialog :deep(.el-dialog__body) {
  padding: 16px 24px 8px;
}

.route-edit-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.route-edit-form :deep(.el-form-item__label) {
  line-height: 32px;
  display: inline-flex;
  align-items: center;
}

.form-label-with-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 1.4;
  white-space: nowrap;
}

.tip-icon {
  color: #909399;
  font-size: 14px;
  cursor: help;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.form-tip {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
  margin-top: 4px;
}

.symbol-checkbox-wrap {
  border: 1px solid #e4e7ed;
  padding: 12px;
  border-radius: 6px;
  height: 300px;
  overflow-y: auto;
  background-color: #fafafa;
}

.symbol-checkbox-item {
  width: 20%;
  min-width: 140px;
  margin-right: 0 !important;
  padding: 4px 8px;
  box-sizing: border-box;
  transition: background-color 0.15s;
  border-radius: 4px;
}

.symbol-checkbox-item:hover {
  background-color: #ecf5ff;
}

.empty-state {
  text-align: center;
  color: #909399;
  padding-top: 100px;
}

.symbol-settings-header {
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.symbol-settings-table :deep(.el-input) {
  max-width: 320px;
}
:deep(.el-select-dropdown__item .option-with-logo) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
</style>
