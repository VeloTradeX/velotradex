import createDebug from 'debug';

export type AppDebugStage =
  | 'message'
  | 'routing'
  | 'parser'
  | 'strategy'
  | 'order';

const APP_DEBUG_PREFIX = 'app';
const MAX_PREVIEW_LENGTH = 120;

function sanitizeNamespacePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function createStageDebug(stage: AppDebugStage): createDebug.Debugger {
  return createDebug(`${APP_DEBUG_PREFIX}:${stage}`);
}

export function createNamedStageDebug(stage: AppDebugStage, name: string): createDebug.Debugger {
  const sanitizedName = sanitizeNamespacePart(name) || 'unknown';
  return createDebug(`${APP_DEBUG_PREFIX}:${stage}:${sanitizedName}`);
}

function previewText(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return `${text.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

export function summarizeDebugMessage(message: any) {
  const content = typeof message?.content === 'string' ? message.content : '';
  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];

  return {
    id: message?.id,
    channelId: message?.channel_id,
    username: message?.username,
    contentLength: content.length,
    contentPreview: previewText(content),
    embedCount: embeds.length,
  };
}
