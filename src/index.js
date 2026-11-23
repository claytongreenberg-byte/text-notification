/**
 * text-notification — iPhone text messages -> Gmail, via a Cloudflare Worker.
 *
 * Flow:
 *   iPhone Shortcuts automation (Message trigger)
 *     -> POST { sender, body } to this Worker
 *     -> Worker emails it to TO_EMAIL, with the sender as the subject
 *        and the message text as the body.
 *
 * iOS 27 WARNING: inside an automation, "Shortcut Input" is EMPTY.
 * The shortcut must use the trigger's own Message variable
 * (Message -> Sender, Message -> Content). Never use Shortcut Input.
 * That is the bug that made the old Mail-app shortcut (and the Fwrd app)
 * send blank emails. See README.md.
 *
 * Email providers (tried in order — see the EMAIL SENDING section below):
 *   1. Cloudflare Email Sending (MailChannels) via the `SEB` send_email
 *      binding in wrangler.toml. No API key needed. Requires the FROM
 *      domain to be active on Cloudflare with SPF/DKIM records.
 *   2. Resend, if a RESEND_API_KEY secret is set:
 *        wrangler secret put RESEND_API_KEY
 *   If neither is configured, POSTs fail with a clear 502.
 *
 * Privacy: logs carry timestamp, sender, delivery status and provider —
 * never the message body (unless LOG_BODIES=true, off by default).
 */

const MAX_SENDER_LENGTH = 200;
const MAX_BODY_LENGTH = 5000;
const RATE_LIMIT_PER_MINUTE = 60;

// Best-effort, per-isolate rate limit. This is a guard against a runaway
// loop (e.g. a misfiring automation), not a security boundary — the
// shared secret is the real guard.
let rateWindowStart = 0;
let rateWindowCount = 0;

function rateLimited() {
  const now = Date.now();
  if (now - rateWindowStart > 60_000) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount > RATE_LIMIT_PER_MINUTE;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function log(event) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

// ---------------------------------------------------------------------------
// EMAIL SENDING — this is the one place that talks to a mail provider.
// To change how mail goes out, change only this function.
// ---------------------------------------------------------------------------
async function sendEmail(env, { from, to, subject, text }) {
  // Provider 1: Cloudflare Email Sending (MailChannels). No API key needed.
  // The binding is declared in wrangler.toml as [[send_email]] name = "SEB".
  // The FROM domain must be active on Cloudflare with SPF/DKIM records,
  // or MailChannels rejects the send.
  if (env.SEB) {
    const result = await env.SEB.send({
      from: { email: from, name: "Text Forward" },
      to,
      subject,
      text,
    });
    return { provider: "mailchannels", messageId: result?.messageId ?? null };
  }

  // Provider 2: Resend (https://resend.com, free tier: 100/day).
  // Set the key with:  wrangler secret put RESEND_API_KEY
  // The FROM domain must be verified in Resend (DNS TXT records).
  if (env.RESEND_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      const err = new Error(`resend rejected the send (${resp.status}): ${detail}`);
      err.provider = "resend";
      err.code = `resend_${resp.status}`;
      throw err;
    }
    const data = await resp.json();
    return { provider: "resend", messageId: data?.id ?? null };
  }

  const err = new Error(
    "no email provider configured: deploy with the send_email binding " +
      "(MailChannels) or set a RESEND_API_KEY secret — see README",
  );
  err.provider = "none";
  throw err;
}
// ---------------------------------------------------------------------------
// End of email-sending section.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health / config check. Safe to open in a browser. Shows only
    // booleans about what is configured — never any secret.
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return json({
        ok: true,
        service: "text-notification",
        version: "1.0.0",
        email: {
          mailchannels: Boolean(env.SEB),
          resend: Boolean(env.RESEND_API_KEY),
        },
        secretRequired: Boolean(env.FORWARD_SECRET),
      });
    }

    if (
      request.method !== "POST" ||
      (url.pathname !== "/" && url.pathname !== "/forward")
    ) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    // Shared secret (optional, but strongly recommended). Set with:
    //   wrangler secret put FORWARD_SECRET
    // The shortcut sends it as the X-Forward-Secret header.
    // A `secret` field in the JSON body is also accepted.
    if (env.FORWARD_SECRET) {
      const provided =
        request.headers.get("x-forward-secret") ?? payload.secret ?? "";
      if (provided !== env.FORWARD_SECRET) {
        log({ event: "unauthorized" });
        return json({ ok: false, error: "unauthorized" }, 401);
      }
    }

    const sender =
      typeof payload.sender === "string" ? payload.sender.trim() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    if (!sender || !body) {
      return json({ ok: false, error: "missing_sender_or_body" }, 400);
    }
    if (sender.length > MAX_SENDER_LENGTH || body.length > MAX_BODY_LENGTH) {
      return json({ ok: false, error: "message_too_long" }, 413);
    }

    if (rateLimited()) {
      log({ event: "rate_limited", sender });
      return json({ ok: false, error: "rate_limited" }, 429);
    }

    const to = env.TO_EMAIL || "claytongreenberg@gmail.com";
    const from = env.FROM_EMAIL || "texts@voiceofdfw.com";

    try {
      const result = await sendEmail(env, {
        from,
        to,
        subject: sender,
        text: body,
      });
      log({
        event: "forwarded",
        sender,
        chars: body.length,
        provider: result.provider,
        messageId: result.messageId,
        // Bodies are never logged unless LOG_BODIES is explicitly "true".
        ...(env.LOG_BODIES === "true" ? { body: body.slice(0, 200) } : {}),
      });
      return json({
        ok: true,
        provider: result.provider,
        messageId: result.messageId,
      });
    } catch (err) {
      log({
        event: "failed",
        sender,
        chars: body.length,
        provider: err.provider || "unknown",
        code: err.code || "",
        message: String(err.message || err).slice(0, 300),
      });
      return json(
        {
          ok: false,
          error: "send_failed",
          provider: err.provider || "unknown",
          detail: String(err.message || err).slice(0, 300),
        },
        502,
      );
    }
  },
};
