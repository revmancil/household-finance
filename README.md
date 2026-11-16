# Household Finance

A small Cloudflare Worker that links personal bank accounts through Plaid, using the same
Plaid keys as MissionLedger, and keeps balances and transactions in the `household-finance`
D1 database. It syncs twice a day (about 5:15 AM and 5:15 PM Central). Mancil's AI OS
finance dashboard reads that database.

The database is already created and has its tables (`schema.sql`).

## Deploy (one time, about 10 minutes)

```bash
npm install
npx wrangler login            # if this machine isn't logged in to Cloudflare yet

# Secrets: use the SAME Plaid production keys MissionLedger uses on Render
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET

# A new random encryption key for stored Plaid tokens (do not reuse MissionLedger's)
openssl rand -hex 32          # copy the output, then:
npx wrangler secret put ENC_KEY

# A PIN of 8+ characters for the bank-link page
npx wrangler secret put ADMIN_PIN

npx wrangler deploy
```

Wrangler prints the Worker URL, for example `https://household-finance.<your-subdomain>.workers.dev`.

## Link your banks

1. Open the Worker URL and enter your PIN.
2. Tap **Link a bank**, sign in to your bank in the Plaid window, and pick the accounts.
3. The first sync pulls up to two years of transactions.

If a bank asks you to sign in again later, the page shows **Reconnect** next to it.
**Hide** keeps an account (for example a business card) out of the dashboard.

## Recommended: put Cloudflare Access in front

The PIN protects the page, but Cloudflare Access adds a real login. In the Cloudflare
dashboard: Zero Trust → Access → Applications → Add → Self-hosted, domain = the Worker URL,
policy = allow your email only.

## Plaid notes

- Uses the Transactions product only (`/accounts/get` and `/transactions/sync`). No Balance
  product calls, so no per-call balance fees; balances are as of each sync.
- Each linked bank is a Plaid Item on the MissionLedger Plaid account, billed per your Plaid
  agreement. Check that personal use fits that agreement.
- Access tokens are stored AES-GCM encrypted with `ENC_KEY`. Only the last 4 digits of
  account numbers are stored.

## Useful commands

```bash
npm run logs                  # live Worker logs
npx wrangler d1 execute household-finance --remote --command "SELECT * FROM sync_log ORDER BY id DESC LIMIT 10"
```
