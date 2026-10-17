import { describe, it, expect, vi } from "vitest";
import { ShopContext } from "../../../src/client/shop-context.js";
import type { EtsyClient } from "../../../src/client/etsy-client.js";

describe("ShopContext", () => {
  it("returns an explicit shop_id without calling Etsy", async () => {
    const get = vi.fn();
    const shop = new ShopContext({ get } as unknown as EtsyClient);
    await expect(shop.resolve(42)).resolves.toBe(42);
    expect(get).not.toHaveBeenCalled();
  });

  it("looks up the seller's own shop once and caches it", async () => {
    const get = vi.fn().mockResolvedValue({ user_id: 1, shop_id: 777 });
    const shop = new ShopContext({ get } as unknown as EtsyClient);
    const both = await Promise.all([shop.resolve(), shop.resolve()]);
    await expect(shop.resolve()).resolves.toBe(777);
    expect(both).toEqual([777, 777]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/users/me");
  });

  it("errors clearly when the account has no shop, then retries on the next call", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ user_id: 1 })
      .mockResolvedValueOnce({ user_id: 1, shop_id: 5 });
    const shop = new ShopContext({ get } as unknown as EtsyClient);
    await expect(shop.resolve()).rejects.toThrow("no shop");
    await expect(shop.resolve()).resolves.toBe(5);
  });
});
