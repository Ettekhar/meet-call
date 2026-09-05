# Meet — Cloudflare Workers version

Same app as before (direct 2-person video call, no login/accept step, plus
chat and opt-in location sharing), but hosted for free on Cloudflare instead
of your own PC. Your PC no longer needs to stay on.

How it's built: a single Cloudflare Worker serves the page, and a Durable
Object (`Room`) holds the "waiting room" for exactly 2 people and relays the
WebRTC handshake between them over a plain WebSocket. Once connected, video,
audio, chat, and location all flow directly between the two browsers — none
of it passes through Cloudflare.

## Deploy it

You need Node.js installed locally just to run the deploy tool (`wrangler`) —
nothing runs on Node afterwards, it all runs on Cloudflare's edge.

1. Unzip this folder and open a terminal in it.
2. Install the deploy tool:
   ```
   npm install
   ```
3. Log in to Cloudflare (opens a browser window, free account is fine):
   ```
   npx wrangler login
   ```
4. Deploy:
   ```
   npx wrangler deploy
   ```
5. Wrangler prints a URL like `https://meet.<your-subdomain>.workers.dev`.
   That's your permanent link — share it with your partner. It works
   whenever either of you opens it, with no server to keep running.

## Renaming or deleting a deployment

Cloudflare uses the `name` field in `wrangler.jsonc` as the Worker's actual
identifier — changing it and redeploying creates a brand-new Worker rather
than renaming the existing one. The old one keeps running until you delete
it separately.

To delete an old deployment (e.g. one previously named `couple-call`):
```
npx wrangler delete --name couple-call
```
It'll ask for confirmation, then remove the Worker and its Durable Object
data. You can also do this from the dashboard: Workers & Pages → select the
Worker → Settings → Delete.

To shut down *this* one later:
```
npx wrangler delete
```
(run from this folder — it reads the name from `wrangler.jsonc` automatically)

## Redeploying after changes

If you ever edit `public/client.js`, `public/index.html`, or
`src/worker.js`, just run `npx wrangler deploy` again — it's near-instant.

## Cost

This app's traffic (2 people, occasional calls) is nowhere close to
Cloudflare's free tier limits for Workers + Durable Objects. It should
cost $0 to run.

## Custom domain (optional)

If you own a domain, you can point it at this Worker for a nicer link
(e.g. `call.yourdomain.com`) via the Cloudflare dashboard → Workers &
Pages → your Worker → Settings → Domains & Routes.
