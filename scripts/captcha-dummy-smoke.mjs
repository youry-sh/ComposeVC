import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ab = require(path.join(root, "electron/tools/antiBrowser.cjs"));

const debugPort = Number(process.argv[2] || 54451);
const name = process.argv[3] || "ts-hook-verify-k9m2";

const sess = await ab.attachSession({
  antiRoot: path.join(root, "anti"),
  name,
  debugPort,
  autoClose: false,
  url: "https://demo.turnstile.workers.dev/",
});

await ab.navigate(sess, "https://demo.turnstile.workers.dev/");
await ab.fill(sess, { label: "User name", value: "demo" });
const r = await ab.captchaPass(sess, { submit: false });
console.log(
  JSON.stringify(
    {
      ok: r.ok,
      solved: r.solved,
      method: r.method,
      provider: r.provider || r.captcha?.provider,
      token_in_dom_len: r.token_in_dom_len,
      token_ready: r.token_ready,
      formFieldLen: r.inject?.formFieldLen,
      fieldOk: r.inject?.fieldOk,
      note: String(r.note || "").slice(0, 200),
    },
    null,
    2
  )
);

const dom = await ab.evaluate(
  sess,
  `(() => {
    const el = document.querySelector('input[name="cf-turnstile-response"]');
    let getLen = -1;
    try {
      if (window.turnstile && window.turnstile.getResponse) {
        getLen = String(window.turnstile.getResponse() || "").length;
      }
    } catch (e) {}
    return {
      fieldLen: el ? String(el.value || "").length : 0,
      fieldHead: el ? String(el.value || "").slice(0, 30) : null,
      getLen,
      hasHook: typeof window.__ANTI_TS_INJECT__ === "function",
    };
  })()`
);
console.log("DOM", JSON.stringify(dom.result || dom));

await ab.click(sess, { text: "Sign in" });
await new Promise((r) => setTimeout(r, 1500));
const after = await ab.evaluate(
  sess,
  `(() => ({ url: location.href, body: (document.body.innerText||'').slice(0,300) }))()`
);
console.log("AFTER", JSON.stringify(after.result || after));
process.exit(0);
