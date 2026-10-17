import type { EtsyClient } from "./etsy-client.js";

/** Resolves which shop a tool acts on: an explicit shop_id, else the signed-in seller's own shop (looked up once). */
export class ShopContext {
  private pending: Promise<number> | null = null;

  constructor(private client: Pick<EtsyClient, "get">) {}

  async resolve(shopId?: number): Promise<number> {
    if (shopId !== undefined) return shopId;
    if (!this.pending) {
      this.pending = this.lookup().catch((err) => {
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }

  private async lookup(): Promise<number> {
    const me = await this.client.get<{ user_id: number; shop_id?: number }>("/users/me");
    if (!me.shop_id) {
      throw new Error("This Etsy account has no shop. Pass shop_id explicitly.");
    }
    return me.shop_id;
  }
}
