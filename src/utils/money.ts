/** Etsy's money object: amount / divisor = value in currency_code. */
export interface EtsyMoney {
  amount: number;
  divisor: number;
  currency_code: string;
}

/** Converts to whole hundredths so sums don't drift with floating point. */
export function toCents(money: EtsyMoney): number {
  return Math.round((money.amount * 100) / money.divisor);
}

export function centsToDecimal(cents: number): number {
  return cents / 100;
}
