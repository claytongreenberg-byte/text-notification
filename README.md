# text-notification

> When I get a text: I should also get automated notification in my Gmail

Forwards iPhone text messages to Gmail, without going through the Mail app.

**The problem it solves:** the old setup used a Shortcuts automation with a
Send Email action. It kept sending blank emails — and the Fwrd app did the
same. The cause turned out to be iOS 27 (see below): inside an automation,
`Shortcut Input` is empty, so the email had no sender and no text.

**How this works instead:**

```
iPhone text arrives
  -> Shortcuts automation (Message trigger)
  -> Get Contents of URL: POST { sender, body } to this Worker
  -> Cloudflare Worker emails it to claytongreenberg@gmail.com
     (sender as the subject, message text as the body)
```

The Mail app is out of the chain entirely. The Worker also logs every
forward (timestamp, sender, delivery result) so a missing text can be traced.

- **Cost:** free tier on both sides (Cloudflare Workers free tier;
  Cloudflare Email Sending via MailChannels, or Resend free tier).
- **Privacy:** message bodies are never written to any log by default
  (see "Logs" below). The Worker holds no messages after sending.

## ⚠️ The iOS 27 rule — read this first

**On iOS 27, `Shortcut Input` is EMPTY inside an automation.** That is the
bug that broke the old setup. In the shortcut, never use Shortcut Input.
Use the trigger's own **Message** variable instead:

- Sender → tap the field, **Select Variable → Message → Sender**
- Message text → tap the field, **Select Variable → Message → Content**

If an email ever arrives blank again, this is the first thing to check:
the two fields above must say **Message**, not Shortcut Input.

## Deploy the Worker (Clayton's step)

No Cloudflare credentials live in this repo. Deploy from your own machine
(or any machine logged into your Cloudflare account):

```bash
git clone https://github.com/claytongreenberg-byte/text-notification.git
cd text-notification
npm install
npx wrangler login          # opens Cloudflare in your browser — sign in
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL when it finishes. It will look like:

```
https://text-notification.<your-subdomain>.workers.dev
```

(The exact subdomain is whatever your Cloudflare account uses — the same
one your GameDay Live sync Worker already runs under.)

Then set a shared secret so nobody else can use the endpoint to send you
mail (the shortcut sends this secret with every forward):

```bash
npx wrangler secret put FORWARD_SECRET
# type a long random phrase when prompted, then:
npx wrangler deploy
```

If you ever need to rotate it, run the same two commands with a new phrase
and update the shortcut header to match.

## Before it can send email

The Worker sends mail through **Cloudflare Email Sending (MailChannels)**,
which needs no API key — but it only works if the sending domain is active
on Cloudflare with SPF/DKIM records. The sender here is
`texts@voiceofdfw.com`.

> **Not yet verified:** whether `voiceofdfw.com` is active on Cloudflare
> could not be checked from the machine that built this repo (its DNS
> lookups return filtered results). Check it yourself before relying on
> the MailChannels path:
>
> 1. Open the Cloudflare dashboard → pick `voiceofdfw.com`.
> 2. If the dashboard shows the domain as **Active**, you are good.
> 3. Go to **Email → Email Routing** and enable it if it is not already —
>    enabling it is what adds the SPF/DKIM records MailChannels requires.
> 4. Deploy, then run the curl test below. If the test returns
>    `{"ok":true,...}`, MailChannels works and you are done.

**If the domain is NOT on Cloudflare**, use the Resend fallback instead —
no DNS changes at Cloudflare, and no code changes:

1. Create a free account at https://resend.com (free tier: 100 emails/day).
2. In Resend, verify `voiceofdfw.com` as a sending domain — Resend shows
   you the DNS TXT records to add at your registrar.
3. Create an API key in Resend (Permissions: Sending access).
4. Store it as a Worker secret and redeploy:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   npx wrangler deploy
   ```
5. The Worker tries MailChannels first and Resend second, so if the
   MailChannels binding is present it wins. To force Resend only, remove
   the `[[send_email]]` block from `wrangler.toml` and redeploy.

Either way, run the curl test below to prove mail actually flows before
you wire up the phone.

## iPhone shortcut (Clayton's step — the automation must be made on the phone)

No repo or app can create this for you; Apple requires it to be built in
Shortcuts on the device. It takes about five minutes.

1. Open **Shortcuts → Automation tab → +**.
2. Choose **Message** as the trigger.
3. Tap **Message Contains** and type **one space** (a single space makes it
   match every text — a space looks blank, so press space once and move on).
4. Turn **Run Immediately** ON and **Allow Running When Locked** ON.
   (On iOS 27 these may be labelled "Automation" — same idea: it must run
   on its own, with no tap and no unlock.)
5. Tap **Next → New Blank Automation**.
6. Add the action **Get Contents of URL**.
7. Tap the URL field and enter your Worker URL from the deploy step:
   `https://text-notification.<your-subdomain>.workers.dev/`
8. Tap the action to expand it and set:
   - **Method:** POST
   - **Headers:** add one header —
     - Key: `Content-Type`, Value: `application/json`
     - add a second header — Key: `X-Forward-Secret`,
       Value: the phrase you set with `wrangler secret put FORWARD_SECRET`
       (skip this header if you did not set a secret)
   - **Request Body:** JSON
9. Add two keys to the JSON body. **This is the step that matters most:**
   - Key `sender` — tap its value, then **Select Variable → Message →
     Sender**. (NOT Shortcut Input.)
   - Key `body` — tap its value, then **Select Variable → Message →
     Content**. (NOT Shortcut Input.)
10. Tap **Done**.

Test it: have someone else text you. An email should land in Gmail
within a few seconds, with the sender as the subject and the text as the
body. (Texting yourself usually does not trip the trigger.)

## Test from a computer

```bash
# Health check — shows what is configured, no secrets:
curl https://text-notification.<your-subdomain>.workers.dev/

# Send a test forward (include the secret header if you set one):
curl -X POST https://text-notification.<your-subdomain>.workers.dev/ \
  -H 'Content-Type: application/json' \
  -H 'X-Forward-Secret: <your-secret-phrase>' \
  -d '{"sender": "Test Person", "body": "This is a test forward"}'
```

A working send returns `{"ok":true,"provider":"mailchannels","messageId":"..."}`.

## Logs — tracing a missing text

Every forward writes one JSON line to the Worker's logs:

```json
{"at":"2026-11-23T22:30:00.000Z","event":"forwarded","sender":"Mom","chars":42,"provider":"mailchannels","messageId":"..."}
```

View them live with:

```bash
npx wrangler tail
```

or in the Cloudflare dashboard → Workers & Pages → text-notification → Logs.

What the log tells you:

| Log event | Meaning |
| --- | --- |
| `forwarded` | The email went out. If Gmail has no matching mail, check Spam. |
| `failed` | The send failed — the `code`/`message` fields say why. |
| `unauthorized` | A request arrived with the wrong (or missing) secret. |
| `rate_limited` | More than 60 forwards in a minute — a runaway automation. |

**Bodies are never logged by default.** If you ever need to debug a
specific garbled message, you can opt in temporarily with:

```bash
npx wrangler secret put LOG_BODIES   # set to "true", redeploy, then set back to "false"
```

(As a `[vars]` value it is `"false"` in `wrangler.toml`; a secret of the
same name overrides it.)

## Security notes

- The shared secret (`FORWARD_SECRET`) is the main guard. Without it, the
  endpoint is public and anyone who finds the URL could send you mail.
  Set it before relying on this.
- The MailChannels binding in `wrangler.toml` is locked to one sender
  (`texts@voiceofdfw.com`) and one recipient
  (`claytongreenberg@gmail.com`), so even a leaked URL cannot be used to
  send mail anywhere else.
- Best-effort rate limit: 60 forwards per minute per Worker isolate.
- No secrets are stored in this repo. Secrets live only as Worker secrets
  (`wrangler secret put ...`).

## Files

| File | What it is |
| --- | --- |
| `src/index.js` | The whole Worker. The email-sending section is marked in the code — change providers there and nowhere else. |
| `wrangler.toml` | Worker name, `send_email` binding, and non-secret settings. |
| `test/smoke.mjs` | Runs the Worker in Node with mocked providers. `npm test` — 24 checks, no Cloudflare account needed. |
| `package.json` | Scripts: `deploy`, `dev`, `tail`, `test`. |
| `.dev.vars.example` | Template for local `wrangler dev` secrets. Copy to `.dev.vars` (git-ignored). |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Email arrives but is blank | Shortcut used Shortcut Input (empty on iOS 27) | Re-wire the two JSON fields to **Message → Sender** and **Message → Content** (see the iOS 27 rule above) |
| No email arrives at all | Automation is not firing | Check Run Immediately and Allow Running When Locked are ON; test with a text from someone else, not yourself |
| `{"ok":false,"error":"unauthorized"}` | Secret mismatch | The `X-Forward-Secret` header must match `FORWARD_SECRET` exactly; re-set both |
| `{"ok":false,"error":"send_failed","provider":"mailchannels"}` | Domain not active on Cloudflare, or SPF/DKIM missing | See "Before it can send email" — enable Email Routing for voiceofdfw.com, or switch to the Resend fallback |
| `{"ok":false,"error":"send_failed","provider":"none"}` | No provider configured | The `[[send_email]]` binding was removed and no `RESEND_API_KEY` secret is set — add one of them |
| `{"ok":false,"error":"send_failed","provider":"resend"}` | Resend key or domain problem | The `detail` field carries Resend's message — usually an unverified domain or a bad key |
| Shortcut asks you to tap something | "Show Compose Sheet" or a confirmation is on | This shortcut has no Send Email action and no compose sheet — if you see one, you are in the old shortcut, not this one |
