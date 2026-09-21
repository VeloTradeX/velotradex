import axios from 'axios';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { LighterRestTxClient } from '../../../../src/services/exchanges/lighter/LighterRestTxClient';
import { LighterSignerBridge } from '../../../../src/services/exchanges/lighter/LighterSignerBridge';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('LighterSignerBridge', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('writes JSON to signer stdin and parses signed transaction stdout', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'lighter-signer-'));
    const signerPath = path.join(tempDir, 'signer.js');
    await writeFile(
      signerPath,
      `#!/usr/bin/env node
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(stdin);
  if (process.argv[2] !== 'sign') {
    process.stderr.write('bad command');
    process.exit(2);
  }
  if (payload.apiPrivateKey !== 'private-key-1') {
    process.stderr.write('bad key');
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({
    txType: 14,
    txInfo: '0xabc',
    txInfoHash: payload.intent.clientOrderIndex
  }), () => { process.exit(0); });
});
`,
    );
    await chmod(signerPath, 0o755);
    const signer = new LighterSignerBridge(signerPath, {
      apiPrivateKey: 'private-key-1',
      baseURL: 'https://mainnet.zklighter.elliot.ai',
      accountIndex: 7,
      apiKeyIndex: 2,
    });

    await expect(
      signer.sign({
        action: 'create-order',
        symbol: 'BTC-USDC',
        marketIndex: 1,
        side: 'buy',
        price: '65000',
        amount: '0.01',
        clientOrderIndex: 'hash-1',
      }),
    ).resolves.toEqual({ txType: 14, txInfo: '0xabc', txInfoHash: 'hash-1' });
  });

  it('passes signer runtime configuration to the signer process', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'lighter-signer-'));
    const signerPath = path.join(tempDir, 'signer.js');
    await writeFile(
      signerPath,
      `#!/usr/bin/env node
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(stdin);
  process.stdout.write(JSON.stringify({
    txType: 14,
    txInfo: JSON.stringify({
      baseURL: payload.baseURL,
      accountIndex: payload.accountIndex,
      apiKeyIndex: payload.apiKeyIndex,
      nonce: payload.intent.nonce
    }),
    txInfoHash: 'hash-2'
  }), () => { process.exit(0); });
});
`,
    );
    await chmod(signerPath, 0o755);
    const signer = new LighterSignerBridge(signerPath, {
      apiPrivateKey: 'private-key-2',
      baseURL: 'https://testnet.zklighter.elliot.ai',
      accountIndex: 9,
      apiKeyIndex: 3,
    });

    await expect(
      signer.sign({
        action: 'create-order',
        nonce: '42',
      }),
    ).resolves.toEqual({
      txType: 14,
      txInfo: JSON.stringify({
        baseURL: 'https://testnet.zklighter.elliot.ai',
        accountIndex: 9,
        apiKeyIndex: 3,
        nonce: '42',
      }),
      txInfoHash: 'hash-2',
    });
  });

  it('requests websocket auth tokens from the signer process', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'lighter-signer-'));
    const signerPath = path.join(tempDir, 'signer.js');
    await writeFile(
      signerPath,
      `#!/usr/bin/env node
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(stdin);
  if (process.argv[2] !== 'auth-token') {
    process.stderr.write('bad command');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    token: 'auth:' + payload.accountIndex + ':' + payload.apiKeyIndex,
    expiresAt: payload.deadline
  }), () => { process.exit(0); });
});
`,
    );
    await chmod(signerPath, 0o755);
    const signer = new LighterSignerBridge(signerPath, {
      apiPrivateKey: 'private-key-3',
      baseURL: 'https://mainnet.zklighter.elliot.ai',
      accountIndex: 11,
      apiKeyIndex: 4,
    });

    await expect(signer.createAuthToken()).resolves.toEqual({
      token: 'auth:11:4',
      expiresAt: expect.any(Number),
    });
  });
});

describe('LighterRestTxClient', () => {
  beforeEach(() => {
    mockedAxios.create.mockReset();
  });

  it('rejects sendTx HTTP 200 responses when API code is not 200', async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { code: 400, message: 'invalid nonce' },
    });
    mockedAxios.create.mockReturnValue({ post } as never);
    const client = new LighterRestTxClient('https://mainnet.zklighter.elliot.ai');

    await expect(client.sendTx(14, '0xabc')).resolves.toEqual({
      accepted: false,
      raw: { code: 400, message: 'invalid nonce' },
      error: 'invalid nonce',
    });
  });

  it('accepts sendTx only when HTTP is 2xx, API code is 200, and tx hash exists', async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: { code: 200, tx_hash: 'tx-hash-1' },
    });
    mockedAxios.create.mockReturnValue({ post } as never);
    const client = new LighterRestTxClient('https://mainnet.zklighter.elliot.ai');

    await expect(client.sendTx(14, '0xabc')).resolves.toEqual({
      accepted: true,
      raw: { code: 200, tx_hash: 'tx-hash-1' },
      txHash: 'tx-hash-1',
    });

    expect(post).toHaveBeenCalledWith(
      '/api/v1/sendTx',
      expect.any(URLSearchParams),
      expect.objectContaining({
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
  });
});
