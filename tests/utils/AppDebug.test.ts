import createDebug from 'debug';
import {
  createStageDebug,
  createNamedStageDebug,
  summarizeDebugMessage,
} from '../../src/utils/debug';

describe('app debug helpers', () => {
  afterEach(() => {
    createDebug.disable();
  });

  it('creates app-prefixed stage namespaces', () => {
    const messageDebug = createStageDebug('message');
    const parserDebug = createNamedStageDebug('parser', 'NeilParser');

    expect(messageDebug.namespace).toBe('app:message');
    expect(parserDebug.namespace).toBe('app:parser:NeilParser');
  });

  it('uses debug namespace matching for stage loggers', () => {
    createDebug.enable('app:parser:*');

    expect(createStageDebug('message').enabled).toBe(false);
    expect(createNamedStageDebug('parser', 'NeilParser').enabled).toBe(true);
  });

  it('summarizes large message payloads for debug logs', () => {
    const summary = summarizeDebugMessage({
      id: 'msg-1',
      channel_id: 'channel-1',
      content: 'x'.repeat(180),
      username: 'alice',
      embeds: [{ description: 'embed text' }],
    });

    expect(summary).toEqual({
      id: 'msg-1',
      channelId: 'channel-1',
      username: 'alice',
      contentLength: 180,
      contentPreview: `${'x'.repeat(117)}...`,
      embedCount: 1,
    });
  });
});
