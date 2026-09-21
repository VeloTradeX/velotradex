import { spawn as nodeSpawn } from 'child_process';
import { constants } from 'fs';
import { access } from 'fs/promises';
import { Readable, Writable } from 'stream';
import { LighterTxIntent } from './types';
import type { LighterAuthToken } from './LighterWsStateClient';

const SIGNER_TIMEOUT_MS = 10000;
const SIGNER_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface LighterSignerOutput {
  txType: number;
  txInfo: string;
  txInfoHash: string;
}

interface LighterSignerAuthTokenOutput {
  token: string;
  expiresAt: number;
}

export type LighterSignerChild = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): LighterSignerChild;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): LighterSignerChild;
};

export type LighterSignerSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'pipe' },
) => LighterSignerChild;

export interface LighterSignerConfig {
  apiPrivateKey: string;
  baseURL: string;
  accountIndex: number;
  apiKeyIndex: number;
}

export class LighterSignerBridge {
  constructor(
    private readonly signerPath: string,
    private readonly config: LighterSignerConfig,
    private readonly spawnImpl: LighterSignerSpawn = nodeSpawn as LighterSignerSpawn,
  ) {}

  async assertUsable(): Promise<void> {
    await access(this.signerPath, constants.X_OK);
  }

  async sign(intent: LighterTxIntent): Promise<LighterSignerOutput> {
    const stdout = await this.runSigner('sign', JSON.stringify({
      apiPrivateKey: this.config.apiPrivateKey,
      baseURL: this.config.baseURL,
      accountIndex: this.config.accountIndex,
      apiKeyIndex: this.config.apiKeyIndex,
      intent,
    }));

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error('Lighter signer returned invalid JSON');
    }

    if (!this.isSignerOutput(parsed)) {
      throw new Error('Lighter signer returned invalid signed transaction');
    }

    return parsed;
  }

  async createAuthToken(deadline?: number): Promise<LighterAuthToken> {
    const expiresAt = deadline ?? Math.floor(Date.now() / 1000) + 7 * 60 * 60;
    const stdout = await this.runSigner('auth-token', JSON.stringify({
      apiPrivateKey: this.config.apiPrivateKey,
      baseURL: this.config.baseURL,
      accountIndex: this.config.accountIndex,
      apiKeyIndex: this.config.apiKeyIndex,
      deadline: expiresAt,
    }));

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error('Lighter signer returned invalid JSON');
    }

    if (!this.isAuthTokenOutput(parsed)) {
      throw new Error('Lighter signer returned invalid auth token');
    }

    return {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
    };
  }

  private runSigner(command: string, stdinPayload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.signerPath, [command], { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('Lighter signer timed out'));
      }, SIGNER_TIMEOUT_MS);

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.kill('SIGKILL');
        reject(error);
      };

      child.stdout.on('data', chunk => {
        const value = String(chunk);
        stdoutBytes += Buffer.byteLength(value);
        if (stdoutBytes > SIGNER_MAX_OUTPUT_BYTES) {
          fail(new Error('Lighter signer stdout exceeded maxBuffer'));
          return;
        }
        stdout += value;
      });

      child.stderr.on('data', chunk => {
        const value = String(chunk);
        stderrBytes += Buffer.byteLength(value);
        if (stderrBytes > SIGNER_MAX_OUTPUT_BYTES) {
          fail(new Error('Lighter signer stderr exceeded maxBuffer'));
          return;
        }
        stderr += value;
      });

      child.on('error', error => {
        fail(error);
      });

      child.on('close', (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);

        if (code !== 0) {
          reject(new Error(`Lighter signer exited with code ${code ?? signal}: ${this.redactSecret(stderr.trim())}`));
          return;
        }

        resolve(stdout);
      });

      child.stdin.write(stdinPayload);
      child.stdin.end();
    });
  }

  private redactSecret(value: string): string {
    if (!value) {
      return value;
    }
    return value.split(this.config.apiPrivateKey).join('[REDACTED]');
  }

  private isSignerOutput(value: unknown): value is LighterSignerOutput {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Partial<LighterSignerOutput>;
    return (
      Number.isInteger(candidate.txType) &&
      typeof candidate.txInfo === 'string' &&
      typeof candidate.txInfoHash === 'string'
    );
  }

  private isAuthTokenOutput(value: unknown): value is LighterSignerAuthTokenOutput {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Partial<LighterSignerAuthTokenOutput>;
    const expiresAt = candidate.expiresAt;
    return (
      typeof candidate.token === 'string' &&
      candidate.token.length > 0 &&
      typeof expiresAt === 'number' &&
      Number.isInteger(expiresAt) &&
      expiresAt > 0
    );
  }
}
