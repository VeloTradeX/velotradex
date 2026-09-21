<template>
  <el-dialog v-model="visible" title="AI 配置" width="900px">
    <el-form ref="formRef" :model="form" :rules="rules" label-width="150px" v-loading="loading">
      <el-form-item label="AI 提供商" prop="provider">
        <el-select v-model="form.provider" placeholder="选择提供商">
          <el-option label="OpenAI" value="openai" />
          <!-- Future: Gemini, Anthropic -->
        </el-select>
      </el-form-item>

      <el-form-item label="Base URL" prop="baseUrl">
        <el-input v-model="form.baseUrl" placeholder="Optional (e.g. https://api.deepseek.com/v1)" />
        <div class="form-tip">如果使用第三方中转服务，请在此输入 API Base URL。</div>
      </el-form-item>

      <el-form-item label="API Key" prop="apiKey">
        <el-input v-model="form.apiKey" type="password" show-password placeholder="sk-..." />
      </el-form-item>

      <el-form-item label="文本大模型" prop="textModel">
        <div style="display: flex; gap: 10px; width: 100%;">
          <el-select
            v-model="form.textModel"
            filterable
            allow-create
            default-first-option
            placeholder="gpt-4o, deepseek-chat..."
            style="flex-grow: 1"
          >
            <el-option
              v-for="item in modelOptions"
              :key="item.value"
              :label="item.value"
              :value="item.value"
            />
          </el-select>
          <el-button @click="fetchModels" :loading="fetchingModels" :icon="Refresh" circle />
        </div>
      </el-form-item>

      <el-form-item label="多模态大模型" prop="visionModel">
        <div style="display: flex; gap: 10px; width: 100%;">
          <el-select
            v-model="form.visionModel"
            filterable
            allow-create
            default-first-option
            placeholder="gpt-4o, glm-4v..."
            style="flex-grow: 1"
          >
            <el-option
              v-for="item in modelOptions"
              :key="item.value"
              :label="item.value"
              :value="item.value"
            />
          </el-select>
        </div>
      </el-form-item>

      <el-form-item label="移除中文" prop="stripChinese">
        <el-switch v-model="form.stripChinese" active-text="开启" inactive-text="关闭" />
        <div class="form-tip">是否在发请求给大模型时剥离所有中文字符，避免大模型幻觉和翻译偏差。</div>
      </el-form-item>

      <el-form-item label="上下文消息数" prop="contextMessageCount">
        <el-input-number v-model="form.contextMessageCount" :min="0" :max="20" />
        <div class="form-tip">分析时包含最近几条历史消息作为上下文。</div>
      </el-form-item>

      <el-form-item label="调用超时(ms)" prop="requestTimeoutMs">
        <el-input-number v-model="form.requestTimeoutMs" :min="1000" :step="1000" />
        <div class="form-tip">AI 请求超时时间，单位毫秒。会用于测试连接和默认解析请求。</div>
      </el-form-item>

      <el-form-item label="额外请求参数" prop="extraPayload">
        <el-input
          v-model="form.extraPayload"
          type="textarea"
          :rows="8"
          placeholder='例如: {"thinking":{"type":"disabled"}}'
        />
        <div class="form-tip">留空表示不附加额外请求参数。内容必须是 JSON 对象。</div>
        <div class="form-tip">阿里云兼容接口通常使用 <code>enable_thinking</code>。如果这里填写 <code>thinking.type</code>，后端在阿里云兼容地址下会自动转换。</div>
        <div class="form-tip">小米接口通常使用 <code>thinking.type</code>，例如 <code>{"thinking":{"type":"enabled"}}</code> 或 <code>{"thinking":{"type":"disabled"}}</code>。</div>
      </el-form-item>

      <el-form-item label="提示词模板" prop="promptTemplate">
        <el-input
          v-model="form.promptTemplate"
          type="textarea"
          :rows="15"
          placeholder="System Prompt..."
        />
        <div class="form-tip">
          可用变量: <span v-pre>{{currentPrice}}</span>, <span v-pre>{{context}}</span>, <span v-pre>{{message}}</span>。<br>
          必须要求 AI 输出严格的 JSON 格式。
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="success" @click="testConfig" :loading="testing">测试连接</el-button>
      <el-button type="primary" @click="saveConfig" :loading="saving">保存配置</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'

const visible = defineModel<boolean>({ required: true })

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const fetchingModels = ref(false)
const formRef = ref()
const modelOptions = ref<any[]>([])

const validateExtraPayload = (_rule: any, value: string, callback: (error?: Error) => void) => {
  if (!value || !value.trim()) {
    callback()
    return
  }

  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      callback(new Error('额外请求参数必须是 JSON 对象'))
      return
    }
    callback()
  } catch {
    callback(new Error('额外请求参数必须是合法 JSON'))
  }
}

const form = reactive({
  id: null as number | null,
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  textModel: 'gpt-4o',
  visionModel: 'gpt-4o',
  stripChinese: true,
  requestTimeoutMs: 60000,
  extraPayload: '',
  contextMessageCount: 5,
  promptTemplate: ''
})

const rules = {
  provider: [{ required: true, message: '请选择提供商', trigger: 'change' }],
  apiKey: [{ required: true, message: '请输入 API Key', trigger: 'blur' }],
  textModel: [{ required: true, message: '请输入文本模型名称', trigger: 'blur' }],
  visionModel: [{ required: true, message: '请输入多模态模型名称', trigger: 'blur' }],
  requestTimeoutMs: [{ required: true, message: '请输入调用超时', trigger: 'change' }],
  extraPayload: [{ validator: validateExtraPayload, trigger: 'blur' }],
  promptTemplate: [{ required: true, message: '请输入提示词模板', trigger: 'blur' }]
}

const fetchConfig = async () => {
  loading.value = true
  try {
    const res = await request.get('/ai-config')
    const data = res.data;

    if (data && data.id) {
        form.id = data.id;
        form.provider = data.provider;
        form.apiKey = data.apiKey;
        form.baseUrl = data.baseUrl || '';
        form.textModel = data.textModel || data.model || 'gpt-4o'; // fallback to old `model` if migrating
        form.visionModel = data.visionModel || data.model || 'gpt-4o';
        form.stripChinese = data.stripChinese !== undefined ? data.stripChinese : true;
        form.requestTimeoutMs = data.requestTimeoutMs || 60000;
        form.extraPayload = data.extraPayload || '';
        form.contextMessageCount = data.contextMessageCount;
        form.promptTemplate = data.promptTemplate;
    } else {
        // Set Defaults
        form.requestTimeoutMs = 60000
        form.extraPayload = ''
        form.promptTemplate = `<system>
</system>

<market>
  <current_price>{{currentPrice}}</current_price>
</market>

{{positions}}

{{context}}

<current_message>
  <text>{{message}}</text>
</current_message>

<output_format>
{
  "action": "open|close|update|cancel|ignore",
  "symbol": "BTC_USDT",
  "side": "buy|sell (required when action=open)",
  "entryPrice": "number (required when action=open)",
  "targets": [number],
  "stopLoss": "number (required when action=open)",
  "leverage": number,
  "confidence": "number (0-1)",
  "reasoning": "string"
}
</output_format>`;
    }
  } catch (error) {
    ElMessage.error('获取配置失败')
  } finally {
    loading.value = false
  }
}

const saveConfig = async () => {
    if (!formRef.value) return;

    await formRef.value.validate(async (valid: boolean) => {
        if (valid) {
            saving.value = true;
            try {
                const payload = { ...form };
                if (form.id) {
                    await request.put(`/ai-config/${form.id}`, payload);
                } else {
                    await request.post('/ai-config', payload);
                }
                ElMessage.success('配置已保存');
                fetchConfig(); // Reload to be sure
            } catch (e: any) {
                ElMessage.error(e.response?.data?.error || '保存失败');
            } finally {
                saving.value = false;
            }
        }
    });
}

const testConfig = async () => {
    if (!form.apiKey) {
        ElMessage.warning('请输入 API Key');
        return;
    }

    testing.value = true;
    try {
        const payload = {
            apiKey: form.apiKey,
            baseUrl: form.baseUrl || undefined,
            textModel: form.textModel,
            extraPayload: form.extraPayload || undefined,
            requestTimeoutMs: form.requestTimeoutMs
        };
        const res = await request.post('/ai-config/test', payload, { timeout: form.requestTimeoutMs + 5000 });
        if (res.data.success) {
            ElMessage.success(res.data.message);
        } else {
            ElMessage.error(res.data.message);
        }
    } catch (e: any) {
        ElMessage.error('测试失败: ' + (e.response?.data?.message || e.message));
    } finally {
        testing.value = false;
    }
}

const fetchModels = async () => {
    if (!form.apiKey) {
        ElMessage.warning('请输入 API Key');
        return;
    }

    fetchingModels.value = true;
    try {
        const payload = {
            apiKey: form.apiKey,
            baseUrl: form.baseUrl || undefined,
            requestTimeoutMs: form.requestTimeoutMs
        };
        const res = await request.post('/ai-config/models', payload, { timeout: form.requestTimeoutMs + 5000 });
        if (Array.isArray(res.data)) {
            modelOptions.value = res.data.map(m => ({ value: m }));
            ElMessage.success(`获取到 ${res.data.length} 个模型`);
        } else {
            modelOptions.value = [];
            ElMessage.warning('未获取到模型列表');
        }
    } catch (e: any) {
        ElMessage.error('无法获取模型列表: ' + (e.response?.data?.error || e.message));
    } finally {
        fetchingModels.value = false;
    }
}

// 组件随父级挂载即拉取配置，等价于原父组件 onMounted 中的 fetchConfig，
// 保证点击「设置」打开弹窗时已是最新配置。
onMounted(() => {
  fetchConfig()
})
</script>

<style scoped>
.form-tip {
    font-size: 12px;
    color: #909399;
    line-height: 1.4;
    margin-top: 5px;
}
</style>
