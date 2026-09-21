<template>
  <el-dialog v-model="visible" :title="isEdit ? '编辑交易所' : '添加交易所'" width="780px" top="3vh" class="exchange-form-dialog">
    <el-form :model="form" label-width="110px" ref="formRef" :rules="rules" class="exchange-edit-form">
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="ID" prop="id">
            <el-input v-model="form.id" :disabled="isEdit" placeholder="例如: gate_main" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="名称" prop="name">
            <el-input v-model="form.name" placeholder="例如: Gate 主账号" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item label="类型" prop="type">
        <el-radio-group v-model="form.type" :disabled="isEdit" class="exchange-type-group">
          <el-radio-button value="gate">
            <ExchangeLogo type="gate" size="md" class="type-logo" />
            <span class="type-btn-label">Gate.io</span>
          </el-radio-button>
          <el-radio-button value="gate_tradfi">
            <ExchangeLogo type="gate_tradfi" size="md" class="type-logo" />
            <span class="type-btn-label">Gate TradFi</span>
          </el-radio-button>
          <el-radio-button value="lighter">
            <ExchangeLogo type="lighter" size="md" class="type-logo" />
            <span class="type-btn-label">Lighter</span>
          </el-radio-button>
          <el-radio-button value="binance">
            <ExchangeLogo type="binance" size="md" class="type-logo" />
            <span class="type-btn-label">Binance</span>
          </el-radio-button>
          <el-radio-button value="virtual_gate">
            <ExchangeLogo type="virtual_gate" size="md" class="type-logo" />
            <span class="type-btn-label">Virtual Gate</span>
          </el-radio-button>
          <el-radio-button value="virtual_gate_tradfi">
            <ExchangeLogo type="virtual_gate_tradfi" size="md" class="type-logo" />
            <span class="type-btn-label">Virtual Gate TradFi</span>
          </el-radio-button>
        </el-radio-group>
        <div class="form-tip" v-if="typeDescription">
          {{ typeDescription }}
        </div>
      </el-form-item>
      <el-form-item label="状态" prop="status" v-if="isEdit">
        <el-radio-group v-model="form.status">
          <el-radio-button value="active">Active</el-radio-button>
          <el-radio-button value="inactive">Inactive</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-divider content-position="left">{{ configSectionTitle }}</el-divider>

      <template v-if="form.type === 'gate' || form.type === 'binance'">
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="API Key" prop="config.apiKey">
            <el-input v-model="form.config.apiKey" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="API Secret" prop="config.apiSecret">
            <el-input v-model="form.config.apiSecret" type="password" show-password />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="Base URL" prop="config.baseURL">
            <el-input v-model="form.config.baseURL" :placeholder="form.type === 'binance' ? 'https://fapi.binance.com' : 'https://api.gateio.ws/api/v4'" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="WS URL" prop="config.wsURL">
            <el-input v-model="form.config.wsURL" :placeholder="form.type === 'binance' ? '' : 'wss://fx-ws.gateio.ws/v4/ws/usdt'" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="Proxy" prop="config.proxy">
            <el-input v-model="form.config.proxy" placeholder="http://127.0.0.1:7890" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="Testnet" prop="config.isTestnet">
            <el-switch v-model="form.config.isTestnet" />
          </el-form-item>
        </el-col>
      </el-row>
      </template>
      <template v-else-if="form.type === 'gate_tradfi'">
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="API Key" prop="config.apiKey">
            <el-input v-model="form.config.apiKey" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="API Secret" prop="config.apiSecret">
            <el-input v-model="form.config.apiSecret" type="password" show-password />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="Base URL" prop="config.baseURL">
            <el-input v-model="form.config.baseURL" placeholder="https://api.gateio.ws/api/v4" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="WS URL" prop="config.wsURL">
            <el-input v-model="form.config.wsURL" placeholder="wss://fx-ws.gateio.ws/v4/ws/tradfi" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="Proxy" prop="config.proxyUrl">
            <el-input v-model="form.config.proxyUrl" placeholder="http://127.0.0.1:7890" />
          </el-form-item>
        </el-col>
      </el-row>
      </template>
      <template v-else-if="form.type === 'lighter'">
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="账户索引" prop="config.accountIndex">
            <el-input v-model.number="form.config.accountIndex" type="number" min="0" placeholder="123" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="API Key 索引" prop="config.apiKeyIndex">
            <el-input v-model.number="form.config.apiKeyIndex" type="number" min="0" placeholder="2" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="私钥" prop="config.privateKey">
            <el-input v-model="form.config.privateKey" type="password" show-password placeholder="留空则保留已保存私钥" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="Signer 路径" prop="config.signerPath">
            <el-input v-model="form.config.signerPath" placeholder="./bin/lighter-signer" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="Base URL" prop="config.baseURL">
            <el-input v-model="form.config.baseURL" placeholder="https://mainnet.zklighter.elliot.ai" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="WS URL" prop="config.wsURL">
            <el-input v-model="form.config.wsURL" placeholder="wss://mainnet.zklighter.elliot.ai/stream" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="余额币种" prop="config.balanceCurrency">
            <el-input v-model="form.config.balanceCurrency" placeholder="USDC" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="滑点 bps" prop="config.defaultSlippageBps">
            <el-input v-model.number="form.config.defaultSlippageBps" type="number" min="0" placeholder="30" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="Proxy" prop="config.proxy">
            <el-input v-model="form.config.proxy" placeholder="http://127.0.0.1:7890" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-alert
          title="市场配置"
          type="info"
          :closable="false"
          style="margin-bottom: 18px;"
      >
        <template #default>
          <div style="font-size: 13px; line-height: 1.6;">
            Lighter 交易所的市场配置已从 <code>dict/lighter_markets.json</code> 自动加载（共 97 个交易对）。<br/>
            如需修改支持的市场，请直接编辑该文件后重启服务。
          </div>
        </template>
      </el-alert>
      </template>
      <template v-else-if="form.type === 'virtual_gate'">
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="初始余额" prop="config.initialBalance">
            <el-input v-model="form.config.initialBalance" placeholder="10000" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="币种" prop="config.currency">
            <el-input v-model="form.config.currency" placeholder="USDT" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="行情源 ID" prop="config.marketDataSourceId">
            <el-input v-model="form.config.marketDataSourceId" placeholder="gate_public_main" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="Tick 过期" prop="config.maxTickAgeMs">
            <el-input v-model.number="form.config.maxTickAgeMs" type="number" min="1000" placeholder="10000" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="自动恢复" prop="config.autoRestore">
            <el-switch v-model="form.config.autoRestore" />
          </el-form-item>
        </el-col>
      </el-row>
      </template>
      <template v-else-if="form.type === 'virtual_gate_tradfi'">
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="初始余额" prop="config.initialBalance">
            <el-input v-model="form.config.initialBalance" placeholder="10000" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="币种" prop="config.currency">
            <el-input v-model="form.config.currency" placeholder="USDT" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="24">
        <el-col :span="12">
          <el-form-item label="Tick 过期" prop="config.maxTickAgeMs">
            <el-input v-model.number="form.config.maxTickAgeMs" type="number" min="1000" placeholder="10000" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="自动恢复" prop="config.autoRestore">
            <el-switch v-model="form.config.autoRestore" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-alert
          title="行情来源"
          type="info"
          :closable="false"
          style="margin-top: 6px;"
      >
        <template #default>
          <div style="font-size: 13px; line-height: 1.6;">
            虚拟 Gate TradFi 采用虚拟撮合机制，行情实时同步自 Gate TradFi 公共行情
            （<code>wss://fx-ws.gateio.ws/v4/ws/tradfi</code>），不产生实盘盈亏。
          </div>
        </template>
      </el-alert>
      </template>
    </el-form>
    <template #footer>
      <span class="dialog-footer">
        <el-button type="success" @click="testConnection" :loading="testing"
          style="margin-right: 10px">测试连接</el-button>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
      </span>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'
import ExchangeLogo from './ExchangeLogo.vue'



const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: []
}>()

const visible = ref(false)
const syncVisible = () => emit('update:modelValue', visible.value)
watch(() => props.modelValue, (v) => { visible.value = v })
watch(visible, syncVisible)

const api = request
const submitting = ref(false)
const testing = ref(false)
const isEdit = ref(false)
const formRef = ref()

const createDefaultConfig = () => ({
  apiKey: '',
  apiSecret: '',
  baseURL: 'https://api.gateio.ws/api/v4',
  wsURL: '',
  proxy: '',
  proxyUrl: '',
  isTestnet: false,
  initialBalance: '10000',
  currency: 'USDT',
  marketDataSourceId: 'gate_public_main',
  supportedSymbols: [] as string[],
  maxTickAgeMs: 10000,
  autoRestore: true,
  accountIndex: 0,
  apiKeyIndex: 0,
  privateKey: '',
  signerPath: './bin/lighter-signer',
  balanceCurrency: 'USDC',
  defaultSlippageBps: 30
})

const form = reactive({
  id: '',
  name: '',
  type: 'gate',
  status: 'active',
  config: createDefaultConfig()
})

const configSectionTitle = computed(() => {
  if (form.type === 'virtual_gate') return '虚拟盘配置'
  if (form.type === 'virtual_gate_tradfi') return '虚拟盘配置'
  if (form.type === 'lighter') return 'Lighter 配置'
  if (form.type === 'gate_tradfi') return 'TradFi 配置'
  return 'API 配置'
})

const typeDescription = computed(() => {
  const map: Record<string, string> = {
    gate: 'Gate.io 永续合约交易所 — 配置 API Key / Secret 进行实盘交易',
    gate_tradfi: 'Gate TradFi 传统金融交易所 — 用于股票、外汇等 TradFi 资产交易',
    lighter: 'Lighter 链上 DEX — 通过本地 signer 和私钥进行链上签名交易',
    binance: 'Binance 币安永续合约交易所 — 配置 API Key / Secret 进行实盘交易',
    virtual_gate: '虚拟 Gate 模拟盘 — 使用真实行情进行虚拟撮合，不产生实盘盈亏',
    virtual_gate_tradfi: '虚拟 Gate TradFi 模拟盘 — 实时同步 Gate TradFi 行情进行虚拟撮合，不产生实盘盈亏'
  }
  return map[form.type] || ''
})

watch(() => form.type, (newType) => {
  if (!isEdit.value) {
    if (newType === 'gate') {
      form.config.baseURL = 'https://api.gateio.ws/api/v4'
      form.config.wsURL = 'wss://fx-ws.gateio.ws/v4/ws/usdt'
    } else if (newType === 'gate_tradfi') {
      form.config.baseURL = 'https://api.gateio.ws/api/v4'
      form.config.wsURL = 'wss://fx-ws.gateio.ws/v4/ws/tradfi'
    } else if (newType === 'binance') {
      form.config.baseURL = 'https://fapi.binance.com'
      form.config.wsURL = '' // Binance handles WS internally
    } else if (newType === 'virtual_gate') {
      applyVirtualDefaults(form.config)
    } else if (newType === 'virtual_gate_tradfi') {
      applyVirtualDefaults(form.config)
    } else if (newType === 'lighter') {
      applyLighterDefaults(form.config)
    } else {
      form.config.baseURL = ''
      form.config.wsURL = ''
    }
  }
})

const rules = {
  id: [{ required: true, message: '请输入ID', trigger: 'blur' }],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择类型', trigger: 'change' }]
}

const applyVirtualDefaults = (config: any) => {
  config.initialBalance = config.initialBalance || '10000'
  config.currency = config.currency || 'USDT'
  config.marketDataSourceId = config.marketDataSourceId || 'gate_public_main'
  config.supportedSymbols = Array.isArray(config.supportedSymbols) ? config.supportedSymbols : []
  config.maxTickAgeMs = Number(config.maxTickAgeMs || 10000)
  config.autoRestore = config.autoRestore !== false
}

const applyLighterDefaults = (config: any) => {
  config.baseURL = config.baseURL || 'https://mainnet.zklighter.elliot.ai'
  config.wsURL = config.wsURL || 'wss://mainnet.zklighter.elliot.ai/stream'
  config.accountIndex = Number(config.accountIndex || 0)
  config.apiKeyIndex = Number(config.apiKeyIndex || 0)
  config.signerPath = config.signerPath || './bin/lighter-signer'
  config.balanceCurrency = config.balanceCurrency || 'USDC'
  config.defaultSlippageBps = Number(config.defaultSlippageBps || 30)
}

const applyTradFiDefaults = (config: any) => {
  config.baseURL = config.baseURL || 'https://api.gateio.ws/api/v4'
  config.wsURL = config.wsURL || 'wss://fx-ws.gateio.ws/v4/ws/tradfi'
}

const normalizeLighterConfig = (config: any) => {
  applyLighterDefaults(config)
  if (!isEdit.value && !config.privateKey) {
    throw new Error('新建 Lighter 交易所时必须填写私钥')
  }
  if (!config.signerPath) {
    throw new Error('Lighter signerPath 不能为空')
  }
  config.accountIndex = Number(config.accountIndex)
  config.apiKeyIndex = Number(config.apiKeyIndex)
  config.defaultSlippageBps = Number(config.defaultSlippageBps || 30)
  if (!Number.isFinite(config.accountIndex) || !Number.isFinite(config.apiKeyIndex) || !Number.isFinite(config.defaultSlippageBps)) {
    throw new Error('Lighter accountIndex、apiKeyIndex 和 defaultSlippageBps 必须是数字')
  }
}

const buildSubmitPayload = () => {
  const config = { ...form.config }
  return {
    id: form.id,
    type: form.type,
    name: form.name,
    status: form.status,
    config
  }
}

const testConnection = async () => {
  testing.value = true
  try {
    if (form.type === 'virtual_gate') {
      applyVirtualDefaults(form.config)
    } else if (form.type === 'virtual_gate_tradfi') {
      applyVirtualDefaults(form.config)
    } else if (form.type === 'lighter') {
      normalizeLighterConfig(form.config)
    } else if (form.type === 'gate_tradfi') {
      applyTradFiDefaults(form.config)
    }
    const payload: any = buildSubmitPayload()
    if (isEdit.value && form.id) {
      payload.id = form.id
    }
    const res = await api.post('/exchanges/test', payload)
    const data = res.data
    if (data.success) {
      let msg = data.message || '连接成功'
      if (data.http !== undefined) {
        msg += ` (HTTP: ${data.http ? 'OK' : 'Fail'}, WS: ${data.ws ? 'OK' : 'Fail'})`
      }
      ElMessage.success(msg)
    } else {
      ElMessage.error(`连接失败: ${data.message || data.error}`)
    }
  } catch (e: any) {
    ElMessage.error(`测试请求失败: ${e.response?.data?.error || e.message}`)
  } finally {
    testing.value = false
  }
}

const submitForm = async () => {
  if (!formRef.value) return
  await formRef.value.validate(async (valid: boolean) => {
    if (!valid) return

    submitting.value = true
    try {
      if (form.type === 'virtual_gate') {
        applyVirtualDefaults(form.config)
      } else if (form.type === 'virtual_gate_tradfi') {
        applyVirtualDefaults(form.config)
      } else if (form.type === 'lighter') {
        normalizeLighterConfig(form.config)
      } else if (form.type === 'gate_tradfi') {
        applyTradFiDefaults(form.config)
      }
      if (isEdit.value) {
        await api.put(`/exchanges/${form.id}`, buildSubmitPayload())
      } else {
        await api.post('/exchanges', buildSubmitPayload())
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

const open = (row?: any) => {
  if (row) {
    isEdit.value = true
    form.id = row.id
    form.name = row.name
    form.type = row.type
    form.status = row.status

    // Parse config if string, or use object
    let conf = row.config
    if (typeof conf === 'string') {
      try { conf = JSON.parse(conf) } catch (e) { }
    }

    form.config = {
      apiKey: conf.apiKey || '',
      apiSecret: conf.apiSecret || '',
      baseURL: conf.baseURL || '',
      wsURL: conf.wsURL || '',
      proxy: conf.proxy || '',
      proxyUrl: conf.proxyUrl || '',
      isTestnet: !!conf.isTestnet,
      initialBalance: conf.initialBalance || '10000',
      currency: conf.currency || 'USDT',
      marketDataSourceId: conf.marketDataSourceId || 'gate_public_main',
      supportedSymbols: Array.isArray(conf.supportedSymbols) ? conf.supportedSymbols : [],
      maxTickAgeMs: Number(conf.maxTickAgeMs || 10000),
      autoRestore: conf.autoRestore !== false,
      accountIndex: Number(conf.accountIndex || 0),
      apiKeyIndex: Number(conf.apiKeyIndex || 0),
      privateKey: conf.privateKey || '',
      signerPath: conf.signerPath || './bin/lighter-signer',
      balanceCurrency: conf.balanceCurrency || 'USDC',
      defaultSlippageBps: Number(conf.defaultSlippageBps || 30)
    }
    if (form.type === 'lighter') {
      applyLighterDefaults(form.config)
    } else if (form.type === 'gate_tradfi') {
      applyTradFiDefaults(form.config)
    }
  } else {
    isEdit.value = false
    form.id = ''
    form.name = ''
    form.type = 'gate'
    form.status = 'active'
    form.config = createDefaultConfig()
  }
  visible.value = true
}

defineExpose({ open })
</script>

<style scoped>
.exchange-form-dialog :deep(.el-dialog__body) {
  padding: 16px 24px 8px;
}

.exchange-edit-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.exchange-type-group {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 0;
}

.exchange-type-group :deep(.el-radio-button__inner) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  min-height: 44px;
  font-size: 14px;
}

.type-logo {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.type-logo .exchange-icon {
  font-size: 22px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.type-btn-label {
  font-weight: 500;
}

.form-tip {
  font-size: 12px;
  color: #606266;
  line-height: 1.6;
  margin-top: 8px;
  padding: 8px 12px;
  background-color: #ecf5ff;
  border-left: 3px solid #409eff;
  border-radius: 4px;
}
</style>
