import crypto from 'crypto';
import { UniqueConstraintError } from 'sequelize';

type LighterClientOrderIndexModel = {
  findOne(options: {
    where: {
      exchangeInstanceId: string;
      businessKey: string;
    };
  }): Promise<any | null>;
  create(values: {
    exchangeInstanceId: string;
    businessKey: string;
    clientOrderIndex: string;
  }): Promise<any>;
};

interface LighterClientOrderIndexStoreOptions {
  deriveClientOrderIndex?: (exchangeInstanceId: string, businessKey: string, attempt: number) => string;
  maxAttempts?: number;
}

export class LighterClientOrderIndexStore {
  private readonly deriveClientOrderIndex: (exchangeInstanceId: string, businessKey: string, attempt: number) => string;
  private readonly maxAttempts: number;

  constructor(
    private readonly model: LighterClientOrderIndexModel,
    options: LighterClientOrderIndexStoreOptions = {},
  ) {
    this.deriveClientOrderIndex = options.deriveClientOrderIndex ?? deriveUint48Index;
    this.maxAttempts = options.maxAttempts ?? 16;
  }

  async getOrCreate(exchangeInstanceId: string, businessKey: string): Promise<string> {
    const existing = await this.findExisting(exchangeInstanceId, businessKey);
    if (existing) {
      return existing;
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const clientOrderIndex = this.deriveClientOrderIndex(exchangeInstanceId, businessKey, attempt);

      try {
        const created = await this.model.create({
          exchangeInstanceId,
          businessKey,
          clientOrderIndex,
        });

        return created.clientOrderIndex;
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          const racedExisting = await this.findExisting(exchangeInstanceId, businessKey);
          if (racedExisting) {
            return racedExisting;
          }

          lastError = error;
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error(`Unable to allocate Lighter clientOrderIndex for ${exchangeInstanceId}:${businessKey}`);
  }

  private async findExisting(exchangeInstanceId: string, businessKey: string): Promise<string | null> {
    const row = await this.model.findOne({
      where: {
        exchangeInstanceId,
        businessKey,
      },
    });

    return row?.clientOrderIndex ?? null;
  }
}

function deriveUint48Index(exchangeInstanceId: string, businessKey: string, attempt: number): string {
  const hash = crypto.createHash('sha256').update(`${exchangeInstanceId}:${businessKey}:${attempt}`).digest();
  let value = 0n;

  for (let index = 0; index < 6; index += 1) {
    value = (value << 8n) + BigInt(hash[index]);
  }

  return (value === 0n ? 1n : value).toString();
}
