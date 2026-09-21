import {
  extractMessages,
  getCacheImagesHelpText,
  getCliOptions,
  getHelpText,
  getPreprocessHelpText,
  getWwgHelpText,
  normalizeMessages,
  normalizeWwgMessages,
  runCli,
} from '../../scripts/discord-json-tool';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('discord-json-tool CLI', () => {
  test('shows top-level help', () => {
    expect(getCliOptions([])).toEqual({ command: 'help', args: [] });
    expect(getCliOptions(['--help'])).toEqual({ command: 'help', args: [] });
  });

  test('parses preprocess command arguments', () => {
    expect(getCliOptions(['preprocess', 'in.json', 'out.json'])).toEqual({
      command: 'preprocess',
      args: ['in.json', 'out.json'],
    });
  });

  test('parses cache-images command arguments', () => {
    expect(getCliOptions(['cache-images', 'examples/soul.json'])).toEqual({
      command: 'cache-images',
      args: ['examples/soul.json'],
    });
  });

  test('parses wwg command arguments', () => {
    expect(getCliOptions(['wwg', 'examples/woods.json', 'examples/woods-out.json'])).toEqual({
      command: 'wwg',
      args: ['examples/woods.json', 'examples/woods-out.json'],
    });
  });

  test('renders help text for commands', () => {
    expect(getHelpText()).toContain('preprocess');
    expect(getHelpText()).toContain('wwg');
    expect(getHelpText()).toContain('cache-images');
    expect(getPreprocessHelpText()).toContain('discord-json-tool.ts preprocess <input-json> <output-json>');
    expect(getWwgHelpText()).toContain('discord-json-tool.ts wwg <input-json> <output-json>');
    expect(getCacheImagesHelpText()).toContain('discord-json-tool.ts cache-images [json-file]');
  });
});

describe('discord-json-tool preprocess', () => {
  test('extracts nested message arrays', () => {
    const input = [
      [
        { content: 'a', attachments: [], timestamp: '2026-01-02T00:00:00.000Z', channel_id: '1' },
      ],
      [
        { content: 'b', attachments: [], timestamp: '2026-01-01T00:00:00.000Z', channel_id: '2' },
      ],
    ];

    const messages = extractMessages(input);
    expect(messages).toHaveLength(2);
  });

  test('normalizes and sorts messages by timestamp', () => {
    const input = [
      { content: 'later', attachments: [{ url: 'u2', proxy_url: 'p2', extra: 'x' }], timestamp: '2026-01-02T00:00:00.000Z', channel_id: '2' },
      { content: null, attachments: [{ url: 'u1' }], timestamp: '2026-01-01T00:00:00.000Z', channel_id: null },
    ];

    expect(normalizeMessages(input)).toEqual([
      {
        content: '',
        attachments: [{ url: 'u1', proxy_url: '' }],
        timestamp: '2026-01-01T00:00:00.000Z',
        channel_id: '',
      },
      {
        content: 'later',
        attachments: [{ url: 'u2', proxy_url: 'p2' }],
        timestamp: '2026-01-02T00:00:00.000Z',
        channel_id: '2',
      },
    ]);
  });
});

describe('discord-json-tool wwg', () => {
  test('normalizes wwg messages, keeps only embed descriptions, and sorts by timestamp', () => {
    const input = [
      {
        content: 'later',
        attachments: [{ url: 'drop-me' }],
        timestamp: '2026-01-02T00:00:00.000Z',
        channel_id: '2',
        embeds: [
          { description: 'desc 2', color: 123 },
          { title: 'no description' },
        ],
      },
      {
        content: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        channel_id: null,
        embeds: [{ description: 'desc 1', image: { url: 'drop-me-too' } }],
      },
    ];

    expect(normalizeWwgMessages(input)).toEqual([
      {
        content: '',
        timestamp: '2026-01-01T00:00:00.000Z',
        channel_id: '',
        embeds: [{ description: 'desc 1' }],
      },
      {
        content: 'later',
        timestamp: '2026-01-02T00:00:00.000Z',
        channel_id: '2',
        embeds: [{ description: 'desc 2' }],
      },
    ]);
  });

  test('wwg command writes normalized messages to output JSON', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-json-tool-'));
    const inputFile = path.join(tmpDir, 'in.json');
    const outputFile = path.join(tmpDir, 'out.json');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    fs.writeFileSync(
      inputFile,
      JSON.stringify([
        [
          {
            content: 'kept',
            timestamp: '2026-01-01T00:00:00.000Z',
            channel_id: 'channel',
            attachments: [{ url: 'dropped' }],
            embeds: [{ description: 'embed kept', color: 16036655 }],
          },
        ],
      ]),
      'utf8',
    );

    try {
      await runCli(['wwg', inputFile, outputFile]);

      expect(JSON.parse(fs.readFileSync(outputFile, 'utf8'))).toEqual([
        {
          content: 'kept',
          timestamp: '2026-01-01T00:00:00.000Z',
          channel_id: 'channel',
          embeds: [{ description: 'embed kept' }],
        },
      ]);
    } finally {
      consoleSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
