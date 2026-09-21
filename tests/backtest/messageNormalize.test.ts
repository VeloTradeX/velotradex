import {
  normalizeDiscordMessages,
  buildDiscordMessage,
  NormalizedMessage,
} from '../../src/backtest/messageNormalize';

describe('消息规范化 (messageNormalize)', () => {
  it('解析预处理格式（扁平数组），输出按时间升序', () => {
    const input = [
      { content: 'msg B', timestamp: '2025-06-01T12:05:00.000Z', channel_id: '111' },
      { content: 'msg A', timestamp: '2025-06-01T12:00:00.000Z', channel_id: '111' },
    ];
    const result = normalizeDiscordMessages(input);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.content).toBe('msg A');
    expect(result.messages[1]!.content).toBe('msg B');
    expect(result.skipped).toBe(0);
    expect(result.channels).toEqual(['111']);
    expect(result.rangeStart).toBe('2025-06-01T12:00:00.000Z');
    expect(result.rangeEnd).toBe('2025-06-01T12:05:00.000Z');
  });

  it('解析原始 Discord 导出（嵌套数组完整对象）', () => {
    const input = [
      [
        {
          content: 'Gold buy now @ 4325',
          timestamp: '2025-06-01T09:00:00.000Z',
          channel_id: '222',
          author: { username: 'kacang' },
          attachments: [
            { url: 'https://cdn.example.com/a.png', proxy_url: 'https://media.example.com/a.png', content_type: 'image/png' },
          ],
        },
      ],
    ];
    const result = normalizeDiscordMessages(input);
    expect(result.messages).toHaveLength(1);
    const m = result.messages[0]!;
    expect(m.content).toBe('Gold buy now @ 4325');
    expect(m.username).toBe('kacang');
    expect(m.attachments).toEqual([
      { url: 'https://cdn.example.com/a.png', proxy_url: 'https://media.example.com/a.png' },
    ]);
  });

  it('支持 { messages: [...] } 包装格式', () => {
    const input = {
      messages: [
        { content: 'hello', timestamp: '2025-06-01T10:00:00.000Z', channel_id: '333' },
      ],
    };
    const result = normalizeDiscordMessages(input);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe('hello');
  });

  it('跳过缺时间/频道/空内容的消息并计数', () => {
    const input = [
      { content: 'ok', timestamp: '2025-06-01T10:00:00.000Z', channel_id: '1' },
      { content: 'no channel', timestamp: '2025-06-01T10:01:00.000Z' },
      { content: 'no time', channel_id: '1' },
      { timestamp: '2025-06-01T10:02:00.000Z', channel_id: '1' }, // 无内容且无附件
      { content: 'bad time', timestamp: 'not-a-date', channel_id: '1' },
      '不是对象',
    ];
    const result = normalizeDiscordMessages(input);
    expect(result.messages).toHaveLength(1);
    expect(result.skipped).toBe(5);
  });

  it('按频道+时间+内容+附件去重（跨导出重复包含）', () => {
    const base = { content: 'dup', timestamp: '2025-06-01T10:00:00.000Z', channel_id: '1' };
    const result = normalizeDiscordMessages([base, { ...base }, base]);
    expect(result.messages).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it('附件过滤无 url 项，proxy_url 缺失时回退 url', () => {
    const input = [
      {
        content: '',
        timestamp: '2025-06-01T10:00:00.000Z',
        channel_id: '1',
        attachments: [{ url: '', proxy_url: 'x' }, { url: 'https://a/1.png' }],
      },
    ];
    const result = normalizeDiscordMessages(input);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.attachments).toEqual([
      { url: 'https://a/1.png', proxy_url: 'https://a/1.png' },
    ]);
  });

  it('保留有效 embeds，过滤空 description', () => {
    const input = [
      {
        content: 'x',
        timestamp: '2025-06-01T10:00:00.000Z',
        channel_id: '1',
        embeds: [{ description: 'embed text' }, { description: '' }],
      },
    ];
    const result = normalizeDiscordMessages(input);
    expect(result.messages[0]!.embeds).toEqual([{ description: 'embed text' }]);
  });

  it('buildDiscordMessage 构造运行时管线消息结构', () => {
    const normalized: NormalizedMessage = {
      content: 'Gold buy now',
      attachments: [{ url: 'https://a/1.png', proxy_url: 'https://a/1.png' }],
      timestamp: '2025-06-01T10:00:00.000Z',
      channel_id: '999',
      username: 'kacang',
    };
    const msg = buildDiscordMessage(normalized, 7);
    expect(msg.id).toBe('backtest-7-999');
    expect(msg.channel_id).toBe('999');
    expect(msg.content).toBe('Gold buy now');
    expect(msg.timestamp).toBe('2025-06-01T10:00:00.000Z');
    expect(msg.ts).toBe(Date.parse('2025-06-01T10:00:00.000Z'));
    expect(msg.username).toBe('kacang');
    expect(msg.attachments).toEqual([
      { url: 'https://a/1.png', proxy_url: 'https://a/1.png', is_image: true },
    ]);
  });

  it('buildDiscordMessage 缺省 username 时回退 backtest', () => {
    const normalized: NormalizedMessage = {
      content: 'hi',
      attachments: [],
      timestamp: '2025-06-01T10:00:00.000Z',
      channel_id: '1',
    };
    const msg = buildDiscordMessage(normalized, 0);
    expect(msg.username).toBe('backtest');
    expect(msg.attachments).toEqual([]);
  });

  it('channels 汇总去重且消息按时间全局排序', () => {
    const input = [
      { content: 'c1', timestamp: '2025-06-01T12:00:00.000Z', channel_id: 'a' },
      { content: 'c2', timestamp: '2025-06-01T10:00:00.000Z', channel_id: 'b' },
      { content: 'c3', timestamp: '2025-06-01T11:00:00.000Z', channel_id: 'a' },
    ];
    const result = normalizeDiscordMessages(input);
    expect(result.messages.map(m => m.content)).toEqual(['c2', 'c3', 'c1']);
    expect(result.channels.sort()).toEqual(['a', 'b']);
  });
});
