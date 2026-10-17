# Etsy MCP — Elektron Labs Fork Design

## Overview

A hardened, trimmed fork of [aserper/etsy-mcp](https://github.com/aserper/etsy-mcp) (MIT) for one job: let Claude Code and Claude Desktop on Mothership run Devin's own Etsy shop — orders & shipping, listings & inventory, sales stats, and market research.

Fork: `elektronlabs/etsy-mcp`, cloned to `D:\PROJECTS\etsy-mcp`. Work lands on feature branches with PRs to `main`. `upstream` remote stays pointed at aserper for pulling future fixes.

## Constraints

- **One shop**, owned by Devin. No multi-shop token store.
- **Local stdio only** on Mothership. No HTTP transport, no Docker, no VPS.
- **Etsy app**: personal-access app (covers the developer's own shop). `x-api-key: keystring:shared_secret` (already correct upstream).
- **Redirect URI** must match the URL registered on the Etsy app exactly (Etsy docs).
- **Tokens**: access 1 h, refresh 90 days.
- **Rate limit**: 10 req/s (upstream client already enforces).
- **Out of scope**: buyer messages (not in Etsy Open API v3), multi-shop, remote hosting, shop profile/policy editing.

## Vet result (upstream @ 77e764a)

Clean: only calls `openapi.etsy.com`, `api.etsy.com`, `www.etsy.com`; no exec/eval/child_process; 4 runtime deps (`@modelcontextprotocol/sdk`, `zod`, `dotenv`, `open`); lockfile resolves only to registry.npmjs.org; PKCE S256 + state check present.

## Changes

### 1. Fixes

| # | Problem (upstream) | Fix |
|---|---|---|
| F1 | OAuth callback server listens on a random port (`listen(0)`), so the redirect URI can never match the registered one — login fails. It also binds all interfaces and accepts any path. | Fixed redirect `http://localhost:3003/oauth/redirect` (overridable via `ETSY_REDIRECT_PORT`). Bind `127.0.0.1` only. Ignore requests whose path is not `/oauth/redirect` (e.g. `/favicon.ico`) instead of failing the flow. Clear the 120 s timeout on success. |
| F2 | Requests all 20 scopes (cart, favorites, addresses, email, profile write, billing…). | Request exactly `listings_r listings_w shops_r transactions_r transactions_w` — the set the kept endpoints require per Etsy's OAS 3.0.0 `security` blocks. |
| F3 | Retries POST/PATCH on 5xx and network errors → a timed-out `create_draft_listing` or `create_shipment` can run twice. | Retry on 5xx / network error only for GET, PUT, DELETE. Retry 429 for all methods (request was rejected, not processed). POST/PATCH 5xx → throw immediately with the status. |
| F4 | Refresh failure is swallowed: `getAccessToken` returns `null`, `handleTokenExpired` deletes the token file, and calls go out unauthenticated, surfacing as confusing 401/403s. | Auth failures throw an `EtsyAuthError` whose message tells Claude to call `authenticate`. Token file is only cleared when Etsy returns `invalid_grant` (refresh token dead), not on network errors. |
| F5 | `upload_listing_image` / `upload_listing_video` read any path on disk. Filename derived by splitting on `/`, which breaks on Windows paths. | Allow only `.jpg .jpeg .png .gif .webp` (image) and `.mp4 .mov` (video), checked case-insensitively on the resolved path; reject otherwise. Use `path.basename`. |
| F6 | `dotenv/config` loads `.env` from the process cwd; Claude Desktop/Code launch the server from elsewhere, so keys are never found. dotenv 17 also logs `◇ injecting env…` to stdout, which corrupts the MCP stdio stream. | Load keys from `~/.etsy-mcp/.env` (beside `tokens.json`) with `quiet: true`. Not the project folder: `D:\PROJECTS` is mirrored to the VPS by Syncthing, `.env` included, and Elektron Labs rules forbid plaintext secrets there. Real env vars still win. |

### 2. Tool surface (41 → 33)

**Removed** (outside the four jobs or not worth the risk): `update_shop`, `manage_shop_sections`, `create_shipping_profile`, `update_shipping_profile`, `manage_shipping_destinations`, `get_return_policies`, `manage_return_policy`, `get_user`, `get_user_addresses`, `delete_listing`. Deactivating a listing stays possible via `update_listing` (`state: "inactive"`). `return-policies.ts` and the matching tests are deleted.

**Added:**

- `get_unshipped_orders` — receipts with `was_paid=true`, `was_shipped=false`, `was_canceled=false`, oldest first. Optional `limit` / `offset`.
- `get_sales_summary` — input `start_date`, `end_date` (ISO `YYYY-MM-DD`, inclusive, read as UTC days; the output says so). Pages `getShopReceipts` (limit 100) over the range with `was_canceled=false`, drops receipts whose `status` is `fully refunded`, capped at 2,000 receipts (`truncated: true` if hit). Output:
  - `orders`, `units`, `item_subtotal`, `gross_total` (sum of receipt `grandtotal`), currency, `excluded_refunded_orders`
  - `top_listings` — top 10 by revenue: `listing_id`, `title`, `units`, `revenue`
  - `slow_movers` — active listings (`getListingsByShop state=active`) with zero units in the range, up to 20, oldest `created_timestamp` first
  - Money is converted from Etsy's `{amount, divisor, currency_code}` to decimal numbers.

**Shop ID default:** every tool that takes `shop_id` makes it optional. When omitted, the server calls `GET /users/me` once, caches `shop_id` for the process, and uses it. Errors clearly if the account has no shop.

**Annotations:** every tool registers MCP `annotations` — `readOnlyHint: true` for reads; `readOnlyHint: false` plus `destructiveHint: true` for `delete_listing_image`, `update_listing`, `update_listing_inventory`, `update_receipt`; `destructiveHint: false` for additive writes (`create_draft_listing`, `create_shipment`, `upload_listing_image`, `upload_listing_video`). `openWorldHint: true` on all (they hit Etsy). `authenticate` gets its own `SIGN_IN` annotation (`readOnlyHint: false, destructiveHint: false, openWorldHint: true`): it opens a browser and writes the local token file but changes nothing on Etsy, and it stays on the Claude Code allow list.

Final 33 tools:

- **Auth (1):** `authenticate`
- **Orders (6):** `get_shop_receipts`, `get_receipt`, `get_unshipped_orders`, `update_receipt`, `create_shipment`, `get_shipping_carriers`
- **Transactions (3):** `get_transactions_by_shop`, `get_transaction`, `get_transactions_by_receipt`
- **Listings (5):** `search_listings`, `get_listing`, `get_listings_by_shop`, `create_draft_listing`, `update_listing`
- **Inventory (2):** `get_listing_inventory`, `update_listing_inventory`
- **Images (4):** `get_listing_images`, `upload_listing_image`, `upload_listing_video`, `delete_listing_image`
- **Shop (5):** `get_shop`, `find_shops`, `get_shop_sections`, `get_shipping_profiles`, `get_me`
- **Reviews (2):** `get_reviews_by_listing`, `get_reviews_by_shop`
- **Taxonomy (2):** `get_buyer_taxonomy`, `get_taxonomy_properties`
- **Payments (2):** `get_payments`, `get_ledger_entries` (fees / net payouts)
- **Stats (1):** `get_sales_summary`

(`get_shipping_carriers` moves from shipping.ts to orders.ts; `get_shipping_profiles` to shop.ts; `shipping.ts` is deleted. Stats live in a new `src/tools/stats.ts`.)

### 3. Repo housekeeping

- Delete `.github/workflows/docker-publish.yml`, `Dockerfile`. Keep `test.yml` and `stale.yml`.
- `.env.example` says to copy it to `~/.etsy-mcp/.env` and gains `ETSY_REDIRECT_PORT=3003` (optional) with a comment on registering the callback URL.
- `tests/integration/ping.test.ts` sends `keystring:shared_secret` (upstream sends the bare keystring, which Etsy now rejects).
- `scripts/smoke-stdio.mjs` (`npm run smoke`): starts `dist/index.js` over stdio from another folder and asserts 33 tools.
- README: rewritten for the fork — credit to upstream, what changed, the 33-tool table, setup. Keep the upstream MIT `LICENSE` untouched.
- `package.json`: version `1.1.0-elektron`, keep author, add `contributors` entry.

## Setup (Devin, one time)

1. etsy.com/developers → Create app (personal access). Callback URL: `http://localhost:3003/oauth/redirect`.
2. Copy keystring + shared secret into `C:\Users\Devin\.etsy-mcp\.env` (outside the Syncthing-mirrored project tree).
3. `npm ci && npm run build`.
4. Register:
   - Claude Code: `claude mcp add etsy -s user -- node D:\PROJECTS\etsy-mcp\dist\index.js`
   - Claude Desktop: `claude_desktop_config.json` → `"etsy": { "command": "node", "args": ["D:\\PROJECTS\\etsy-mcp\\dist\\index.js"] }`
5. Claude Code permissions: add the 24 read tools plus `authenticate` (25 names) to the allow list by exact name (`mcp__etsy__<tool>` — every `get_*`, plus `search_listings`, `find_shops`, `authenticate`); leave the 8 write tools unlisted so each write prompts.
6. In Claude: "authenticate with Etsy" → browser consent → tokens saved to `~/.etsy-mcp/tokens.json`.

## Testing

- Existing vitest suite stays green (tests for removed tools are deleted with them).
- New unit tests, written first (TDD):
  - F1: callback URL is exactly `http://localhost:3003/oauth/redirect`; server binds `127.0.0.1`; `/favicon.ico` does not reject the flow; port override via env.
  - F2: authorization URL `scope` equals the five scopes.
  - F3: POST 5xx → single attempt, throws; GET 5xx → retries; POST 429 → retries.
  - F4: refresh network error keeps the token file and throws `EtsyAuthError`; `invalid_grant` clears it.
  - F5: `.exe` / `.env` paths rejected; `C:\pics\a.PNG` accepted with basename `a.PNG`.
  - Shop ID default: omitted `shop_id` → one `/users/me` call, cached across tools.
  - `get_unshipped_orders`: sends the three filters + oldest-first sort.
  - `get_sales_summary`: money math with divisors, cancel exclusion, top-10 ordering, slow movers, 2,000 cap → `truncated`.
  - Every registered tool has annotations; removed tool names are not registered; count is 33.
  - F6: `~/.etsy-mcp/.env` is loaded regardless of cwd; an existing env var is not overwritten; nothing is written to stdout.
- `npm run lint` (tsc) clean, `npm run build` succeeds.
- Live smoke (after Devin's setup, read-only): `authenticate`, `get_me`, `get_shop`, `get_unshipped_orders`, `get_sales_summary` for last 30 days, `search_listings` for a niche keyword. No live writes without Devin's explicit OK.
