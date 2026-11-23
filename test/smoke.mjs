// Smoke test for the text-notification Worker. Runs in plain Node (no wrangler,
// no Cloudflare account) with mocked email providers.
// Usage: npm test
import worker from "../src/index.js";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// Capture the Worker's console.log lines (its forwarding log) separately
// from this test's own output, so we can assert what gets logged.
const logged = [];
const origLog = console.log;
function startCapture() {
  logged.length = 0;
  console.log = (...args) => logged.push(args.join(" "));
}
function stopCapture() {
  console.log = origLog;
}

async function post(env, payload, headers = {}) {
  const req = new Request("https://text-notification.example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  startCapture();
  try {
    return await worker.fetch(req, env);
  } finally {
    stopCapture();
  }
}

const sent = [];
const mockSeb = {
  send: async (msg) => {
    sent.push(msg);
    return { messageId: "mc-test-123" };
  },
};
const baseEnv = { SEB: mockSeb, FORWARD_SECRET: "", LOG_BODIES: "false" };

console.log("text-notification smoke test");

// 1. Health check
{
  const res = await worker.fetch(
    new Request("https://text-notification.example.workers.dev/"),
    baseEnv,
  );
  const data = await res.json();
  check("GET / returns ok + service name", res.status === 200 && data.ok === true && data.service === "text-notification");
  check("GET / reports mailchannels configured", data.email.mailchannels === true);
  check("GET / reports no secret required when unset", data.secretRequired === false);
}

// 2. Valid forward via MailChannels binding
{
  sent.length = 0;
  const res = await post(baseEnv, { sender: "Mom", body: "Call me when you can" });
  const data = await res.json();
  check("POST valid -> 200 ok", res.status === 200 && data.ok === true);
  check("POST valid -> provider is mailchannels", data.provider === "mailchannels");
  check("email to is claytongreenberg@gmail.com", sent[0]?.to === "claytongreenberg@gmail.com");
  check("email subject is the sender", sent[0]?.subject === "Mom");
  check("email text is the message body", sent[0]?.text === "Call me when you can");
  check("email from is texts@voiceofdfw.com", sent[0]?.from?.email === "texts@voiceofdfw.com");
  const logLine = logged.join("\n");
  check("log line records the forward", logLine.includes('"event":"forwarded"') && logLine.includes('"sender":"Mom"'));
  check("log line does NOT contain the message body", !logLine.includes("Call me when you can"));
}

// 3. Validation errors
{
  const badJson = await post(baseEnv, "{not json");
  check("invalid JSON -> 400", badJson.status === 400);
  const missing = await post(baseEnv, { sender: "Mom" });
  check("missing body -> 400", missing.status === 400);
  const empty = await post(baseEnv, { sender: "", body: "" });
  check("empty sender/body -> 400", empty.status === 400);
  startCapture();
  let get404;
  try {
    get404 = await worker.fetch(
      new Request("https://text-notification.example.workers.dev/nope", { method: "POST" }),
      baseEnv,
    );
  } finally {
    stopCapture();
  }
  check("POST to unknown path -> 404", get404.status === 404);
}

// 4. Shared secret
{
  const secretEnv = { ...baseEnv, FORWARD_SECRET: "s3cr3t-phrase" };
  const noSecret = await post(secretEnv, { sender: "Mom", body: "hi" });
  check("wrong/missing secret -> 401", noSecret.status === 401);
  const withHeader = await post(
    secretEnv,
    { sender: "Mom", body: "hi" },
    { "x-forward-secret": "s3cr3t-phrase" },
  );
  check("correct secret header -> 200", withHeader.status === 200);
  const withField = await post(secretEnv, { sender: "Mom", body: "hi", secret: "s3cr3t-phrase" });
  check("correct secret in body -> 200", withField.status === 200);
}

// 5. No provider configured -> clear 502
{
  const res = await post({ FORWARD_SECRET: "" }, { sender: "Mom", body: "hi" });
  const data = await res.json();
  check("no provider -> 502 with provider=none", res.status === 502 && data.provider === "none");
  check("502 explains what to do", data.detail.includes("RESEND_API_KEY"));
}

// 6. Resend fallback (fetch stubbed)
{
  const resendCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    resendCalls.push({ url, opts });
    return { ok: true, json: async () => ({ id: "re_test123" }) };
  };
  const res = await post(
    { FORWARD_SECRET: "", RESEND_API_KEY: "re_testkey" },
    { sender: "Dad", body: "On my way" },
  );
  const data = await res.json();
  globalThis.fetch = origFetch;
  check("resend fallback -> 200", res.status === 200 && data.provider === "resend");
  check("resend called with API key auth", String(resendCalls[0]?.opts?.headers?.Authorization).startsWith("Bearer re_testkey"));
  check("resend body carries sender as subject", JSON.parse(resendCalls[0]?.opts?.body)?.subject === "Dad");
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
