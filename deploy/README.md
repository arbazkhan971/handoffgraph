# Domain & deployment topology

Serving is **Cloudflare-only** (Workers, D1, R2, Queues, KV, Cron Triggers).
The domain registration currently sits at Vercel (registrar only); its
nameservers point at Cloudflare once the zone below exists. No Vercel
deployments remain — the former `handoffgraph-landing` / `handoffgraph-api-proxy`
Vercel projects are retired (see Cleanup).

## One-time zone setup (dashboard, ~2 minutes)

1. dash.cloudflare.com → **Add a site** → `handoffgraph.dev` → **Free** plan.
   Cloudflare assigns two nameservers (shown on the final screen).
2. At the registrar (vercel.com → **Domains → handoffgraph.dev → Advanced →
   Nameservers**) replace `ns1/ns2.vercel-dns.com` with the two Cloudflare
   nameservers.
3. Wait for the zone to activate (usually minutes; up to 24h worst case).

## Platform Worker prerequisites

Provision the Cloudflare resources the Worker binds (one-time):

    cd platform
    npx wrangler r2 bucket create handoffgraph-bodies
    npx wrangler queues create handoffgraph-webhooks
    npx wrangler queues create handoffgraph-webhooks-dlq

Create/configure the WorkOS AuthKit application with this exact callback:

    https://api.handoffgraph.dev/v1/auth/callback

Set secrets through Wrangler; never commit them:

    npx wrangler secret put WORKOS_CLIENT_ID
    npx wrangler secret put WORKOS_API_KEY
    npx wrangler secret put WEBHOOK_SEALING_KEY   # seals outbound-webhook signing secrets at rest

Apply all `platform/migrations/` remotely (`npx wrangler d1 migrations apply
handoffgraph --remote`), confirm the `hosted_beta_capacity` singleton is capped
at 50 lifetime account issuances, and configure Turnstile or equivalent
Cloudflare WAF/rate controls for account creation and device issuance. Confirm
the Basic entitlement still enforces 2 active devices and 10 device-token
issuances over an account lifetime; revocation must not refund an issuance.
The database ceiling and per-workspace quotas bound cost, but they do not
replace edge bot controls. Auth intentionally returns `503` until WorkOS is
configured. Keep the signup switch absent until those gates pass; then set its
exact value to `true`:

    npx wrangler secret put HOSTED_SIGNUP_ENABLED

Existing users may sign in while signup is closed. Paid checkout is not part
of this deployment.

## Go live

After staging verifies the real AuthKit callback, cookies, and quota rollback,
uncomment the `routes` blocks in `landing/wrangler.toml` and
`platform/wrangler.toml` (custom_domain entries), then:

    cd landing  && npx wrangler deploy   # serves https://handoffgraph.dev
    cd platform && npx wrangler deploy   # serves https://api.handoffgraph.dev

Wrangler creates the DNS records and Universal SSL certificates itself.

## Cleanup (Vercel retirement)

The tracked Vercel configs were removed from this repo. If the old projects
still exist in the Vercel dashboard, delete them:

    vercel project rm handoffgraph-landing
    vercel project rm handoffgraph-api-proxy

The Vercel *deployments* go away; the domain registration remains at Vercel
until deliberately transferred.
