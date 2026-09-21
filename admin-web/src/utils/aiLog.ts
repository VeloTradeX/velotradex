/**
 * AI 解析日志相关的纯函数工具。
 * 这些函数不依赖组件状态，已从 AIConfig.vue 抽出作为单一数据源，
 * 供日志表格、日志详情对话框等组件复用。
 */

/** 尝试将未知值解析为 JSON，解析失败则原样返回。 */
export const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value

  const trimmed = value.trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

/** 判断一段文本是否看起来像 Prompt（而非真实消息内容）。 */
export const looksLikePrompt = (value: string): boolean => {
  const text = value.trim()
  return text.startsWith('<') || text.includes('<current_message') || text.includes('<output_format')
}

/** 从日志中提取原始消息的文本与图片地址。 */
export const getOriginalMessageParts = (log: any): { content: string; images: string[] } => {
  const raw = log?.originalMessage
  const parsed = parseMaybeJson(raw)
  const images: string[] = []
  const textParts: string[] = []

  if (log?.imageBase64) {
    images.push(log.imageBase64)
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const contentItem = item as any
      if (contentItem.type === 'text' && typeof contentItem.text === 'string') {
        if (!looksLikePrompt(contentItem.text)) {
          textParts.push(contentItem.text)
        }
      } else if (contentItem.type === 'input_text' && typeof contentItem.text === 'string') {
        if (!looksLikePrompt(contentItem.text)) {
          textParts.push(contentItem.text)
        }
      } else if (typeof contentItem.content === 'string') {
        if (!looksLikePrompt(contentItem.content)) {
          textParts.push(contentItem.content)
        }
      }

      const imageUrl = contentItem.image_url?.url
      if (contentItem.type === 'image_url' && typeof imageUrl === 'string') {
        images.push(imageUrl)
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const message = parsed as any
    if (typeof message.content === 'string' && message.content.trim()) {
      textParts.push(message.content)
    } else if (typeof message.text === 'string') {
      textParts.push(message.text)
    }

    if (Array.isArray(message.embeds)) {
      for (const embed of message.embeds) {
        if (typeof embed?.description === 'string' && embed.description.trim()) {
          textParts.push(embed.description)
        }
      }
    }

    if (Array.isArray(message.attachments)) {
      for (const attachment of message.attachments) {
        const imageUrl = attachment?.proxy_url || attachment?.url
        if (typeof imageUrl === 'string' && imageUrl) {
          images.push(imageUrl)
        }
      }
    }
  } else if (typeof parsed === 'string') {
    if (!looksLikePrompt(parsed)) {
      textParts.push(parsed)
    }
  }

  return {
    content: textParts.join('\n\n'),
    images: Array.from(new Set(images))
  }
}

/** 将未知值解析为数组（用于 routeNames / routeIds 等 JSON 字符串字段）。 */
export const parseJsonArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 将日志中的路由名/路由 ID 格式化为展示文本。 */
export const formatRouteNames = (log: any): string => {
  const names = parseJsonArray(log?.routeNames)
    .map((item) => String(item).trim())
    .filter(Boolean)

  if (names.length) return names.join(', ')

  const ids = parseJsonArray(log?.routeIds)
    .map((item) => String(item).trim())
    .filter(Boolean)
  if (ids.length) return ids.map((id) => `#${id}`).join(', ')

  return '-'
}

/** 将概览值格式化为可读文本（数组/对象/空值处理）。 */
export const formatSummaryValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '-'
  if (Array.isArray(value)) return value.map(formatSummaryValue).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 从响应文本中提取首个 JSON 对象作为概览数据源。 */
export const getResponseSummarySource = (value: unknown): any => {
  const parsed = parseMaybeJson(value)
  if (typeof parsed === 'string') {
    const match = parsed.match(/\{[\s\S]*\}/)
    if (match) {
      return parseMaybeJson(match[0])
    }
  }
  return parsed
}

/** 从 Response 中提取「关键动作」，即首个 JSON 对象的 action 字段；缺失返回 '-'。 */
export const getResponseAction = (log: any): string => {
  const parsed = getResponseSummarySource(log?.response)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const action = (parsed as Record<string, unknown>).action
    if (action !== undefined && action !== null && action !== '') return String(action)
  }
  return '-'
}

/** 将任意值格式化为可展示的 JSON 文本，失败时回退到原值或 fallback。 */
export const formatJsonForDisplay = (value: any, fallback = ''): string => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  if (typeof value !== 'string') {
    return String(value)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return fallback
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return value
  }
}
