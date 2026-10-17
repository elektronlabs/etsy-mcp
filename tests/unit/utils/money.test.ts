import { describe, it, expect } from "vitest";
import { toCents, centsToDecimal } from "../../../src/utils/money.js";

describe("money", () => {
  it("converts Etsy money to hundredths using the divisor", () => {
    expect(toCents({ amount: 2599, divisor: 100, currency_code: "USD" })).toBe(2599);
    expect(toCents({ amount: 1000, divisor: 1, currency_code: "JPY" })).toBe(100000);
    expect(toCents({ amount: 12345, divisor: 1000, currency_code: "USD" })).toBe(1235);
  });

  it("turns hundredths back into a decimal", () => {
    expect(centsToDecimal(4149)).toBe(41.49);
  });
});
