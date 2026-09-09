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

## Storage

Bot state — approvals, balances, bans and pending order watchers — must outlive a
deploy. On Hostinger a deploy **replaces the application directory**, so anything
under `./data` is destroyed on every push and approved users silently become
strangers again.

Two backends, chosen by configuration:

**MySQL (recommended).** Create a database in hPanel under Databases, then set:

```
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=your_db_user
MYSQL_PASSWORD=your_db_password
MYSQL_DATABASE=your_db_name
```

The table is created automatically on first boot, and any existing `./data` files
are imported once if the database is empty.

**Files.** Without MySQL settings, state is JSON under `DATA_DIR` (default `./data`).
Point it somewhere the deploy does not overwrite:

    DATA_DIR=/home/USERNAME/otp-panel-data

On boot the directory is created and a write is actually attempted, so a path that
is not writable fails immediately instead of silently dropping every later save. If
`DATA_DIR` is left unset the app warns loudly that state is ephemeral, and
`GET /api/version` reports `storage.durable` so a deploy can be checked from outside.

State is small, so each key is stored as a single JSON blob rather than a schema. It
is read once at boot into memory and written back debounced, which keeps callers
synchronous. Storage starts **before** the port opens, because handling a Telegram
update against an empty store would treat approved users as strangers.

A configured database that cannot be reached is **fatal** — the app retries a few
times (MySQL is sometimes slow to wake after a deploy) and then refuses to start,
rather than silently falling back to ephemeral storage and recreating the bug. If the
site is down after a deploy, check the database settings first.

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
- **Banned** users are ignored completely: no reply, and no approval request reaches
  the owners. Ban with the Deny button or `/ban <id>`; lift it with `/unban <id>`,
  which returns them to being a stranger rather than re-approving them. A ban also
  revokes existing access and overrides `TELEGRAM_ALLOWED_IDS`. Owners cannot be banned.
- If no owner is configured at all, the first person to `/start` claims the bot.
  Pin `TELEGRAM_OWNER_ID` afterwards so ownership can never be re-claimed.

Access state is persisted through the storage layer above — put it in MySQL, or a
deploy will reset every approval.

### Spending limits

Approving someone grants **access, not money**. A newly approved user can spend
**nothing** until an owner funds them with `/add` — the two are separate decisions,
so approving a stranger can never by itself put the balance at risk. Owners are
never capped; it is their money.

That default comes from `TELEGRAM_DEFAULT_DAILY_LIMIT=0`. Set it to a number of EUR
to give every new user a recurring daily allowance instead, or `none` for unlimited.
With the cap at 0 a user's allowance is purely their granted balance — a wallet that
does not refill — and the bot's wording changes to match ("balance", not "daily
limit"). The two models combine: someone with a €10/day cap *and* €50 granted can
spend €10 a day, drawing on the €50 only once each day's cap is used up.

- Cost is **reserved when the order is placed**, so a burst of orders cannot slip
  past the cap while the first is still pending.
- If an order ends with **no SMS** — expired, canceled or skipped — it was never
  charged, so the reservation is **released** back to that day's allowance.
- `/reuse` reserves half the service price, matching how it is billed.
- The window is the **UTC day**; spend from previous days never counts against today.
- All arithmetic is in integer cents (`amount_minor`), never floats.

Grants are **validated against the real JuicySMS balance**, and across all users
rather than one at a time: every granted cent is a claim on the same shared pot, so
`/add` refuses when the total already granted plus the new grant would exceed what
the account actually holds. Taking credit back is always allowed, and frees headroom
for someone else. If the balance cannot be read, the grant is refused rather than
made on a guess. `/limits` shows the account balance, the total granted, and what is
still free to grant.

A one-off top-up is separate from the cap: `/add <id> <eur>` grants balance that
**does not reset daily** and is spent only once the day’s allowance is used up, so a
user can be given extra without permanently raising their limit. A negative amount
takes it back. Spending draws from the daily allowance first, then the balance, and
a released reservation returns each part to where it came from.

Owner controls: `/limits` shows everyone's cap and today's spend; `/limit <id> <eur>`
sets one (`none` = unlimited, `0` = blocks ordering entirely). Users see their own
position with `/usage`, and `/balance` shows a non-owner their remaining allowance
rather than the account's full balance.

### Statistics

`/stats` reports numbers ordered, codes received, the delivery rate and total spend.
Owners also see a per-user breakdown and the live account balance; everyone else sees
only their own figures.

Spending cannot be reconstructed from order history — the API returns order objects
with **no price field at all** — so it is recorded as it happens: an order when it is
placed, and a charge only when the SMS actually arrives, since an order that never
delivers is never billed. That means the delivery rate is meaningful and the spend
total matches what was really charged.

Only orders placed through the bot are counted; the web panel does not pass through
it, and `/stats` says so rather than implying it is the account’s full history.

### Broadcast

`/broadcast <text>` messages every approved user. Because a broadcast cannot be
recalled, it previews the text and the recipient count first and only sends on
confirmation; the draft is held in memory and expires after ten minutes. Pending and
banned users never receive it, and the sender is skipped.

Formatting uses a small markdown subset — `*bold*`, `_italic_`, and backtick-wrapped
`code` — applied **after** HTML-escaping rather than by permitting raw tags. Escaping
first means a message containing markup is shown literally and can never reach
Telegram as markup, so formatting costs nothing in safety. The markers need a word
boundary, leaving `snake_case` identifiers and URLs containing underscores alone. The
preview renders through the same formatter, so what you confirm is what recipients see.

Delivery is paced at ~60ms per message to stay inside Telegram rate limits, and the
summary reports how many landed plus the ids that failed — usually someone who
blocked the bot.

### Order ids

Order ids are not shown in any message a user can see. A forwarded or
screenshotted message would otherwise identify the order to whoever received it,
and nothing in the bot needs the id on screen: cancel, skip and reuse act on the
open order, and the inline buttons carry it in callback data, which stays between
Telegram and the server. Owners can still retrieve ids with .

### Commands

```
/order <service> [country]   order a number, default UK
/status                      current open order and its code
/cancel                      cancel the open order
/skip                        blacklist this number and get another
/reuse                       reorder the last number at half price
/price <service> [country]   look up a price
/balance                     balance, or your remaining allowance
/usage                       what you have spent today
/stats                       totals for orders and spending
/history                     recent orders
/whoami                      your Telegram id
```

Owner-only:

```
/pending                     access requests waiting on you
/users                       who has access
/revoke <id>                 remove someone's access
/last [n]                    recent orders with their ids (1-10)
/broadcast <text>            message every approved user
/ban <id>                    ignore them completely
/unban <id>                  lift a ban
/limits                      everyone's daily limit and spend
/limit <id> <eur>            set a daily limit (none = unlimited, 0 = blocked)
/add <id> <eur>              add balance on top of the daily limit
/rm <id> <eur|all>           remove balance
```

Countries: `uk`, `usa`, `nl`, `de`, `pl`, `ph`, defaulting to `uk`. The trailing word is
treated as a country only when it is one of those, so `/order google chat` still works.

A country is always sent to `/services`, because the API returns `price: null` without
one — and a null price would be read as free. An order whose price cannot be
determined is refused rather than placed for nothing.

`/skip` matches the website: it blacklists the current number, releases its
reservation, and immediately orders another of the same service and country.

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
