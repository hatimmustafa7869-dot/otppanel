# OTP Panel

A self-hosted SMS/OTP panel on top of the [JuicySMS API v2](https://juicysms.com/api).
Order one-time numbers, watch codes land in real time, browse history, and manage
long-term rentals — all from one page.

## Features

- **Get number** — pick a country and service, optional max-price ceiling, then a live
  card polls for the SMS every 3s with an expiry countdown, one-click copy for both the
  number and the code, and cancel / skip / reuse actions.
- **Orders** — full history with status filter and cursor pagination; expand any order to
  read its messages, or reuse a number at half price.
- **Rentals** — rent NL/UK numbers by package, read their inbox, toggle auto-renew, extend.
- **Prices** — the whole service catalog per country with live pricing; click any service
  to jump straight to ordering it.
- The API key stays server-side. The browser only ever talks to this app's `/api/*` proxy.

## Setup

```bash
npm install
```

Edit `.env`:

```
JUICYSMS_API_KEY=your_api_key_here
PORT=3200
```

Then:

```bash
npm start
```

Open <http://localhost:3200>.

## Login

The panel has a session-based login. It is armed whenever `PANEL_PASS` is set:

```
PANEL_USER=admin
PANEL_PASS=a-long-random-password
SESSION_SECRET=64-hex-chars
```

Once armed, **everything** requires a session — the UI, the static assets, and every
`/api` route that can spend money. Signed-out browsers are redirected to `/login`;
signed-out API calls get `401 not_signed_in`.

- The session cookie is httpOnly, `sameSite=lax`, and `secure` once behind an HTTPS proxy.
- Credentials are compared in constant time, and a failed login never reveals which half
  was wrong.
- Eight failed attempts from one IP locks that IP out for 15 minutes.
- The session id is regenerated on login, so a fixated cookie cannot be reused.
- `SESSION_SECRET` signs the cookie. If unset, a random one is generated per boot, which
  means every restart logs you out — fine locally, set it in production.

**If `PANEL_PASS` is unset the panel runs completely open** and prints a loud warning at
startup. That is only appropriate on localhost. Never deploy it that way: anyone who
reaches the URL can order numbers against your balance.

## API endpoints proxied

| Panel route | Upstream |
|---|---|
| `GET /api/account` | `GET /account` |
| `GET /api/services?country=&search=` | `GET /services` |
| `POST /api/orders` | `POST /orders` |
| `GET /api/orders` | `GET /orders` |
| `GET /api/orders/:id` | `GET /orders/{id}` |
| `GET /api/orders/:id/messages` | `GET /orders/{id}/messages` |
| `POST /api/orders/:id/{cancel,skip,reuse}` | same |
| `GET /api/rental-packages` | `GET /rental-packages` |
| `GET|POST /api/rentals` | `GET|POST /rentals` |
| `GET /api/rentals/:id` · `PATCH /api/rentals/:id` | same |
| `GET /api/rentals/:id/messages` | same |
| `POST /api/rentals/:id/extend` | same |

Upstream status codes and RFC 9457 problem bodies are passed through untouched, so the UI
can react to `out_of_stock`, `insufficient_balance`, `concurrent_order_limit`, and
`rate_limited` by code.

## Telegram bot

Order numbers and receive codes from Telegram. Runs as a **webhook**, not long
polling — the panel is already on public HTTPS, and shared hosting is a poor place
to keep a polling loop alive.

### Access is request-and-approve

The bot's username is discoverable, and every approved user spends the owner's
JuicySMS balance, so access is never open:

- **Owners** are listed in `TELEGRAM_OWNER_ID` (comma-separated). They can approve,
  deny and revoke, and cannot be locked out from chat.
- A **new user** who sends `/start` gets a "waiting for approval" reply, and every
  owner receives an Approve / Deny prompt with that user's name, username and id.
- **Approved** users get a message telling them so, and can use every command.
- **Denied** users get silence on subsequent messages, rather than a reply loop.
- If no owner is configured at all, the first person to `/start` claims the bot.
  Pin `TELEGRAM_OWNER_ID` afterwards so ownership can never be re-claimed.

State lives in `data/tg-users.json` (gitignored), so it survives restarts.

### Commands

```
/order <service> [country]   order a number, default UK
/status                      current open order and its code
/cancel                      cancel the open order
/skip                        cancel and blacklist the number
/reuse                       reorder the last number at half price
/price <service>             look up a price
/balance                     account balance
/history                     recent orders
/whoami                      your Telegram id
```

Owner-only: `/pending`, `/users`, `/revoke <id>`.

Countries: `uk`, `usa`, `nl`, `de`, `pl`, `ph`. The trailing word is treated as a
country only when it is one of those, so `/order google chat` still works.

When an order is placed, the bot watches it and pushes the code into the chat the
moment the SMS lands. Watchers are persisted to `data/watchers.json`, so a redeploy
mid-order does not silently drop it.

### Setup

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_OWNER_ID=2051992452,8897271932
TELEGRAM_WEBHOOK_SECRET=<48 hex chars>
PUBLIC_URL=https://your-panel-domain
```

Then register the webhook with Telegram:

```bash
npm run telegram:set
```

`npm run telegram:status` shows the current webhook and any delivery errors;
`npm run telegram:delete` unregisters it. The token is read from `.env`, so it never
has to be typed on a command line.

The webhook route sits **before** the login guard, since Telegram cannot hold a
session. It is protected by an unguessable path segment plus Telegram's
`X-Telegram-Bot-Api-Secret-Token` header, and the bot itself ignores anyone who is
not approved.

## Currency

JuicySMS prices and charges strictly in **EUR** and never converts. The panel shows an
approximate USD figure beside every euro amount, using ECB reference rates from
`api.frankfurter.dev` (falling back to `open.er-api.com`), fetched via `GET /api/fx` and
cached for an hour. If no rate can be fetched, the UI silently shows EUR alone. USD is
display-only — you are always billed in EUR.

## Code extraction

The panel does **not** trust the API's `code` field, because it is sometimes wrong.
Carriers append an Android SMS Retriever app hash (11 chars) on its own line; the API
strips newlines, gluing it to the code, and their extractor then swallows its leading
digits. A real message:

```
Your WhatsApp code: 760-974
4sgLq1p5sV6            <- app hash, newline removed by the API
```

…arrives as `"…code: 760-9744sgLq1p5sV6"` with `"code":"7609744"` — seven digits for a
six-digit WhatsApp code. `extractCode()` in [public/app.js](public/app.js) parses the text
itself: hyphenated `NNN-NNN` first (matched without a trailing boundary so a glued hash
cannot bleed in), then digits following a code/otp/pin label, then any standalone 4–8
digit run, and only falls back to the API's value if nothing matches.

## Notes

- Prices are EUR. One-time numbers expire after 10 minutes and are charged only if a
  message arrives.
- Order objects from the live API carry no `price` or `charged` field despite the docs
  showing both, and rental packages use `your_price`/`list_price` rather than `price`.
  The UI handles all of these shapes.
- Without `parallel_orders_allowed` on your account, only one order can be open at a time;
  the panel detects `concurrent_order_limit` and re-attaches to the existing open order.
- Rentals are NL and UK only. One-time numbers also cover USA, PH, PL, and DE.
