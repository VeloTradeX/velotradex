import fs from 'fs';
import os from 'os';
import path from 'path';

describe('LogService log source selection', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    jest.resetModules();
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velotradex-logs-'));
    fs.mkdirSync(path.join(tempDir, 'logs'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads error.log when the error source is requested', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'logs', 'combined.log'),
      `${JSON.stringify({ timestamp: '2026-05-06T01:00:00.000Z', level: 'info', message: 'normal log' })}\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'logs', 'error.log'),
      `${JSON.stringify({ timestamp: '2026-05-06T02:00:00.000Z', level: 'error', message: 'error log' })}\n`
    );

    const logService = (await import('../../src/services/LogService')).default;

    const result = await logService.getLogs({ source: 'error', page: 1, pageSize: 20 });

    expect(result.total).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].message).toBe('error log');
  });
});
