# Etsy MCP Server (Elektron Labs fork)

A hardened, trimmed fork of [aserper/etsy-mcp](https://github.com/aserper/etsy-mcp) by Amit Serper. It lets Claude Code and Claude Desktop run one Etsy shop: orders and shipping, listings and inventory, sales stats, and market research.

## What this fork changes

- **Login works.** The OAuth callback is fixed at `http://localhost:3003/oauth/redirect`, which is what Etsy requires (an exact match with the URL registered on your app). It listens on 127.0.0.1 only.
- **Least privilege.** Requests `listings_r listings_w shops_r transactions_r transactions_w` instead of all 20 scopes.
- **No duplicate writes.** POST and PATCH are never retried after a server error or dropped connection.
- **Clear login errors.** An expired or failed login tells Claude to call `authenticate` instead of failing silently.
- **Upload guard.** Image and video upload only read image and video files.
- **Keys outside the project.** Keys load from `~/.etsy-mcp/.env`, next to the tokens. Nothing is printed to stdout.
- **33 tools for one seller.** Shop-admin tools are gone. `get_unshipped_orders` and `get_sales_summary` are new. `shop_id` defaults to your shop. Every tool is marked read-only or write, so clients can ask before writes.

## Tools

| Area | Read | Write |
|---|---|---|
| Orders | `get_unshipped_orders`, `get_shop_receipts`, `get_receipt`, `get_shipping_carriers` | `create_shipment`, `update_receipt` |
| Transactions | `get_transactions_by_shop`, `get_transaction`, `get_transactions_by_receipt` | |
| Listings | `search_listings`, `get_listing`, `get_listings_by_shop` | `create_draft_listing`, `update_listing` |
| Inventory | `get_listing_inventory` | `update_listing_inventory` |
| Images | `get_listing_images` | `upload_listing_image`, `upload_listing_video`, `delete_listing_image` |
| Shop | `get_me`, `get_shop`, `find_shops`, `get_shop_sections`, `get_shipping_profiles` | |
| Reviews | `get_reviews_by_listing`, `get_reviews_by_shop` | |
| Taxonomy | `get_buyer_taxonomy`, `get_taxonomy_properties` | |
| Money | `get_sales_summary`, `get_payments`, `get_ledger_entries` | |
| Auth | | `authenticate` (opens a browser and saves the token file locally; changes nothing on Etsy) |

## Setup

1. Create an app at [etsy.com/developers/your-apps](https://www.etsy.com/developers/your-apps). Set its callback URL to exactly `http://localhost:3003/oauth/redirect`.
2. Create `~/.etsy-mcp/.env` (on Windows, `C:\Users\<you>\.etsy-mcp\.env`) from `.env.example`. Real environment variables take precedence over the file.
3. Build: `npm install && npm run build`
4. Register the server:
   - Claude Code: `claude mcp add etsy -s user -- node /absolute/path/to/etsy-mcp/dist/index.js`
   - Claude Desktop, in `claude_desktop_config.json`:
     ```json
     { "mcpServers": { "etsy": { "command": "node", "args": ["/absolute/path/to/etsy-mcp/dist/index.js"] } } }
     ```
5. Ask Claude to authenticate with Etsy. Your browser opens Etsy's consent page. Tokens are saved to `~/.etsy-mcp/tokens.json` and refreshed automatically. The refresh token lasts 90 days; after that, authenticate again.

To use a different callback port, set `ETSY_REDIRECT_PORT` and register the matching URL on your Etsy app.

## Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript to dist/
npm test             # unit tests
npm run lint         # type check
npm run smoke        # start dist/index.js over stdio and check the tool list
npm run generate-types  # regenerate types from Etsy's OpenAPI spec
```

## Limits

Etsy's Open API v3 has no buyer messaging, cart, favorites or checkout endpoints, so this server can't do those things.

## License

MIT. See [LICENSE](LICENSE). Original project by Amit Serper.

## Disclaimer

This project is not affiliated with, endorsed by, or associated with Etsy, Inc. It uses Etsy's publicly available Open API v3. Use it responsibly and in line with [Etsy's API Terms of Use](https://www.etsy.com/legal/api).
