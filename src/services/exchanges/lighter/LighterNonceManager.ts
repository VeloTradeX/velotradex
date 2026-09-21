import { randomUUID } from 'crypto';
import LighterTxJournal from '../../../models/LighterTxJournal';
import { LighterSignedTx, LighterTxIntent } from './types';
import { LighterSignerOutput } from './LighterSignerBridge';
import { LighterSendTxResult } from './LighterRestTxClient';

type JournalRecord = {
  txId: string;
  nonce: string;
  status: string;
  exchangeInstanceId?: string;
  accountIndex?: number;
  apiKeyIndex?: number;
  txType?: number;
  txInfoHash?: string;
  intentJson?: string;
  strategyId?: number | null;
  orderId?: number | null;
  clientOrderIndex?: string | null;
  error?: string | null;
  save(): Promise<void>;
};

export type LighterTxJournalCreate = {
  create(row: Record<string, unknown>): Promise<JournalRecord>;
};

export interface LighterNonceManagerDeps {
  exchangeInstanceId: string;
  accountIndex: number;
  apiKeyIndex: number;
  signer: {
    sign(intent: LighterTxIntent & { nonce: string }): Promise<LighterSignerOutput>;
  };
  restClient: {
    getNextNonce(accountIndex: number, apiKeyIndex: number): Promise<string>;
    sendTx(txType: number, txInfo: string): Promise<LighterSendTxResult>;
  };
  journalModel?: LighterTxJournalCreate;
}

type IntentWithJournalFields = LighterTxIntent & {
  strategyId?: number;
  orderId?: number;
};

export type LighterSubmitResult = LighterSignedTx & {
  raw: unknown;
  txHash?: string;
  error?: string;
};

export class LighterNonceManager {
  private queue: Promise<unknown> = Promise.resolve();
  private queueLength = 0;
  private nextNonceValue: bigint | undefined;
  private readonly journalModel: LighterTxJournalCreate;

  constructor(private readonly deps: LighterNonceManagerDeps) {
    this.journalModel = deps.journalModel ?? (LighterTxJournal as unknown as LighterTxJournalCreate);
  }

  submit(intent: LighterTxIntent): Promise<LighterSubmitResult> {
    this.queueLength += 1;

    const submission = this.queue.then(() => this.submitNow(intent)).finally(() => {
      this.queueLength -= 1;
    });

    this.queue = submission.catch(() => undefined);
    return submission;
  }

  getQueueLength(): number {
    return this.queueLength;
  }

  private async submitNow(intent: LighterTxIntent): Promise<LighterSubmitResult> {
    const nonce = await this.allocateNonce();
    const txId = randomUUID();
    const intentForSigning = { ...intent, nonce };
    const journal = await this.journalModel.create({
      txId,
      exchangeInstanceId: this.deps.exchangeInstanceId,
      accountIndex: this.deps.accountIndex,
      apiKeyIndex: this.deps.apiKeyIndex,
      nonce,
      txType: 0,
      txInfoHash: '',
      intentJson: JSON.stringify(intent),
      status: 'CREATED',
      strategyId: this.getOptionalNumber(intent, 'strategyId'),
      orderId: this.getOptionalNumber(intent, 'orderId'),
      clientOrderIndex: intent.clientOrderIndex ?? null,
    });

    try {
      const signed = await this.deps.signer.sign(intentForSigning);
      this.advanceNonce();
      journal.txType = signed.txType;
      journal.txInfoHash = signed.txInfoHash;
      journal.status = 'SIGNED';
      await journal.save();

      journal.status = 'SENT';
      await journal.save();

      const sendResult = await this.deps.restClient.sendTx(signed.txType, signed.txInfo);
      if (sendResult.accepted) {
        journal.status = 'ACCEPTED';
        journal.error = null;
      } else {
        journal.status = 'REJECTED';
        journal.error = sendResult.error ?? JSON.stringify(sendResult.raw);
      }
      await journal.save();

      if (!sendResult.accepted) {
        await this.bestEffortRefreshNonceIfNeeded(journal.error);
      }

      return {
        txId,
        txType: signed.txType,
        txInfoHash: signed.txInfoHash,
        nonce,
        signedTx: signed.txInfo,
        clientOrderIndex: intent.clientOrderIndex,
        raw: sendResult.raw,
        txHash: sendResult.txHash,
        error: sendResult.error,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      journal.status = journal.txInfoHash ? 'UNKNOWN' : 'REJECTED';
      journal.error = message;
      await journal.save();
      await this.refreshNonceIfNeeded(message);
      throw error;
    }
  }

  private async allocateNonce(): Promise<string> {
    if (this.nextNonceValue === undefined) {
      this.nextNonceValue = BigInt(
        await this.deps.restClient.getNextNonce(this.deps.accountIndex, this.deps.apiKeyIndex),
      );
    }

    return this.nextNonceValue.toString();
  }

  private advanceNonce(): void {
    if (this.nextNonceValue === undefined) {
      throw new Error('Lighter nonce was not initialized');
    }
    this.nextNonceValue += 1n;
  }

  private async refreshNonceIfNeeded(message: string | null | undefined): Promise<void> {
    if (!message || !message.toLowerCase().includes('nonce')) {
      return;
    }

    this.nextNonceValue = BigInt(
      await this.deps.restClient.getNextNonce(this.deps.accountIndex, this.deps.apiKeyIndex),
    );
  }

  private async bestEffortRefreshNonceIfNeeded(message: string | null | undefined): Promise<void> {
    try {
      await this.refreshNonceIfNeeded(message);
    } catch (error) {
      // Rejected transactions are final for this submit call; nonce recovery is for future submissions only.
    }
  }

  private getOptionalNumber(intent: LighterTxIntent, key: keyof IntentWithJournalFields): number | null {
    const value = (intent as IntentWithJournalFields)[key];
    return typeof value === 'number' ? value : null;
  }
}
