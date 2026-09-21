import { OrderParams } from '../IExchange';
import { LighterTxIntent } from './types';

export type LighterIntentKind =
  | 'place_order'
  | 'create_grouped_orders'
  | 'cancel_order'
  | 'set_leverage'
  | 'set_margin_mode'
  | 'amend_order';

export type LighterAdapterIntent = LighterTxIntent & {
  kind: LighterIntentKind;
  triggerPrice?: string;
  payload: Record<string, unknown>;
};

export function buildIntent(
  kind: LighterIntentKind,
  fields: Omit<Partial<LighterAdapterIntent>, 'action' | 'kind'> & { payload: Record<string, unknown> },
): LighterTxIntent {
  return {
    ...fields,
    action: kind,
    kind,
  } as LighterAdapterIntent;
}

export function buildBusinessKey(params: OrderParams): string {
  return [
    params.symbol,
    params.side,
    params.type ?? 'limit',
    params.amount,
    params.price ?? 'market',
    params.reduceOnly ? 'reduce' : 'open',
    params.triggerPrice ?? 'no-trigger',
  ].join(':');
}
