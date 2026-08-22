# Domain & deployment topology

Target (per the 300-day plan §7.1): all serving on Cloudflare; the domain
registration stays at Vercel (registrar only) with nameservers pointed at
Cloudflare.

## One-time zone setup (dashboard, ~2 minutes)

1. dash.cloudflare.com → **Add a site** → `handoffgraph.dev` → **Free** plan.
   Cloudflare assigns two nameservers (shown on the final screen).
2. vercel.com → **Domains → handoffgraph.dev → Advanced → Nameservers** →
   replace `ns1/ns2.vercel-dns.com` with the two Cloudflare nameservers.
3. Wait for the zone to activate (usually minutes; up to 24h worst case).

## After the zone is active

Uncomment the `routes` blocks in `landing/wrangler.toml` and
`platform/wrangler.toml` (custom_domain entries), then:

    cd landing  && npx wrangler deploy   # serves https://handoffgraph.dev
    cd platform && npx wrangler deploy   # serves https://api.handoffgraph.dev

Wrangler creates the DNS records and Universal SSL certificates itself.

## Cleanup (after Cloudflare is verified live)

    vercel project rm handoffgraph-landing
    vercel project rm handoffgraph-api

The Vercel *deployments* go away; the domain registration remains at Vercel
until deliberately transferred.
