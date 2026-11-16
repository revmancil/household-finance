/**
 * Household Finance — a small Cloudflare Worker that links personal bank accounts through
 * Plaid (reusing MissionLedger's Plaid keys), keeps balances and transactions in D1, and
 * re-syncs every morning. Mancil's AI OS finance dashboard reads the D1 database directly.
 *
 * Secrets (wrangler secret put …): PLAID_CLIENT_ID, PLAID_SECRET, ENC_KEY, ADMIN_PIN
 * Vars (wrangler.toml): PLAID_ENV = "production" | "sandbox"
 * Binding: DB (D1 "household-finance")
 */

const PLAID_HOSTS = {
  production: "https://production.plaid.com",
  sandbox: "https://sandbox.plaid.com",
};
const TZ = "America/Chicago";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") return html(PAGE);
      if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname.startsWith("/api/")) {
        if (request.method !== "POST") return json({ error: "Use POST." }, 405);
        const denied = await checkPin(request, env);
        if (denied) return denied;
        const body = await request.json().catch(() => ({}));
        switch (url.pathname) {
          case "/api/status": return json(await status(env));
          case "/api/link-token": return json(await linkToken(env, body.item_id));
          case "/api/exchange": return json(await exchange(env, body));
          case "/api/sync": return json(await syncAll(env, body.item_id));
          case "/api/remove": return json(await removeItem(env, body.item_id));
          case "/api/account": return json(await updateAccount(env, body));
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: e.publicMessage || "Something went wrong. Check the Worker logs." }, e.status || 500);
    }
  },

  // Daily sync (see [triggers] in wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};

/* ---------------- auth ---------------- */

async function checkPin(request, env) {
  const pin = request.headers.get("x-pin") || "";
  if (!env.ADMIN_PIN || env.ADMIN_PIN.length < 8) {
    return json({ error: "ADMIN_PIN is not set (8+ characters). Run: wrangler secret put ADMIN_PIN" }, 500);
  }
  const a = new TextEncoder().encode(pin), b = new TextEncoder().encode(env.ADMIN_PIN);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]; // constant time over the PIN's length
  const same = diff === 0;
  if (!same) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    return json({ error: "Wrong PIN." }, 401);
  }
  return null;
}

/* ---------------- Plaid ---------------- */

async function plaid(env, path, body) {
  const host = PLAID_HOSTS[env.PLAID_ENV || "production"];
  if (!host) throw pub("PLAID_ENV must be production or sandbox.", 500);
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw pub("Plaid keys are not set. Run: wrangler secret put PLAID_CLIENT_ID / PLAID_SECRET", 500);
  const res = await fetch(host + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Plaid ${path}: ${data.error_code || res.status} ${data.error_message || ""}`);
    err.plaid = data;
    err.publicMessage = data.display_message || data.error_message || `Plaid returned ${res.status}.`;
    err.status = 502;
    throw err;
  }
  return data;
}

async function linkToken(env, itemId) {
  const base = {
    client_name: "Carroll Household",
    user: { client_user_id: "carroll-household" },
    country_codes: ["US"],
    language: "en",
  };
  if (itemId) {
    // Update mode: re-authenticate an existing bank connection.
    const item = await env.DB.prepare("SELECT access_token_enc FROM items WHERE item_id = ?").bind(itemId).first();
    if (!item) throw pub("That bank connection was not found.", 404);
    const r = await plaid(env, "/link/token/create", { ...base, access_token: await decrypt(env, item.access_token_enc) });
    return { link_token: r.link_token };
  }
  const r = await plaid(env, "/link/token/create", { ...base, products: ["transactions"], transactions: { days_requested: 730 } });
  return { link_token: r.link_token };
}

async function exchange(env, { public_token, institution }) {
  if (!public_token) throw pub("Missing public_token.", 400);
  const r = await plaid(env, "/item/public_token/exchange", { public_token });
  await env.DB.prepare(
    `INSERT INTO items (item_id, institution_id, institution_name, access_token_enc, status)
     VALUES (?, ?, ?, ?, 'ok')
     ON CONFLICT(item_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, status = 'ok', error_code = NULL, error_message = NULL`
  ).bind(r.item_id, institution?.institution_id || null, institution?.name || null, await encrypt(env, r.access_token)).run();
  const result = await syncItem(env, r.item_id);
  return { item_id: r.item_id, ...result };
}

async function syncAll(env, onlyItemId) {
  const { results } = onlyItemId
    ? await env.DB.prepare("SELECT item_id FROM items WHERE item_id = ?").bind(onlyItemId).all()
    : await env.DB.prepare("SELECT item_id FROM items").all();
  const out = [];
  for (const row of results) out.push({ item_id: row.item_id, ...(await syncItem(env, row.item_id)) });
  return { synced: out };
}

async function syncItem(env, itemId) {
  const item = await env.DB.prepare("SELECT * FROM items WHERE item_id = ?").bind(itemId).first();
  if (!item) return { ok: false, error: "not found" };
  const token = await decrypt(env, item.access_token_enc);
  let added = 0, modified = 0, removed = 0;
  try {
    // 1) Accounts and today's balances.
    const acc = await plaid(env, "/accounts/get", { access_token: token });
    const today = localDate();
    const stmts = [];
    for (const a of acc.accounts || []) {
      const b = a.balances || {};
      stmts.push(env.DB.prepare(
        `INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype, current, available, credit_limit, currency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, official_name = excluded.official_name, mask = excluded.mask,
           type = excluded.type, subtype = excluded.subtype, current = excluded.current, available = excluded.available,
           credit_limit = excluded.credit_limit, currency = excluded.currency, updated_at = datetime('now')`
      ).bind(a.account_id, itemId, a.name ?? null, a.official_name ?? null, a.mask ?? null, a.type ?? null, a.subtype ?? null,
        b.current ?? null, b.available ?? null, b.limit ?? null, b.iso_currency_code || b.unofficial_currency_code || null));
      stmts.push(env.DB.prepare(
        `INSERT INTO balance_history (account_id, date, current, available) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, date) DO UPDATE SET current = excluded.current, available = excluded.available`
      ).bind(a.account_id, today, b.current ?? null, b.available ?? null));
    }
    if (acc.item?.institution_id && !item.institution_name) {
      try {
        const inst = await plaid(env, "/institutions/get_by_id", { institution_id: acc.item.institution_id, country_codes: ["US"] });
        stmts.push(env.DB.prepare("UPDATE items SET institution_id = ?, institution_name = ? WHERE item_id = ?")
          .bind(acc.item.institution_id, inst.institution?.name || null, itemId));
      } catch (_) { /* name is cosmetic */ }
    }
    if (stmts.length) await env.DB.batch(stmts);

    // 2) Transactions, incrementally with /transactions/sync.
    let cursor = item.cursor || undefined;
    const startCursor = cursor;
    for (let page = 0, restarts = 0; page < 60; page++) {
      let r;
      try {
        r = await plaid(env, "/transactions/sync", { access_token: token, cursor, count: 500 });
      } catch (e) {
        if (e.plaid?.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restarts++ < 3) { cursor = startCursor; page = -1; continue; }
        throw e;
      }
      const batch = [];
      for (const t of [...(r.added || []), ...(r.modified || [])]) {
        const pfc = t.personal_finance_category || {};
        batch.push(env.DB.prepare(
          `INSERT INTO transactions (transaction_id, account_id, item_id, date, authorized_date, name, merchant_name, amount, currency,
             category, category_detailed, payment_channel, pending, logo_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(transaction_id) DO UPDATE SET account_id = excluded.account_id, date = excluded.date, authorized_date = excluded.authorized_date,
             name = excluded.name, merchant_name = excluded.merchant_name, amount = excluded.amount, currency = excluded.currency,
             category = excluded.category, category_detailed = excluded.category_detailed, payment_channel = excluded.payment_channel,
             pending = excluded.pending, logo_url = excluded.logo_url, updated_at = datetime('now')`
        ).bind(t.transaction_id, t.account_id, itemId, t.date, t.authorized_date ?? null, t.name ?? null, t.merchant_name ?? null,
          t.amount, t.iso_currency_code || t.unofficial_currency_code || null, pfc.primary ?? null, pfc.detailed ?? null,
          t.payment_channel ?? null, t.pending ? 1 : 0, t.logo_url ?? null));
      }
      for (const t of r.removed || []) batch.push(env.DB.prepare("DELETE FROM transactions WHERE transaction_id = ?").bind(t.transaction_id));
      added += (r.added || []).length; modified += (r.modified || []).length; removed += (r.removed || []).length;
      for (let i = 0; i < batch.length; i += 90) await env.DB.batch(batch.slice(i, i + 90));
      cursor = r.next_cursor;
      if (!r.has_more) break;
    }

    await env.DB.prepare("UPDATE items SET cursor = ?, status = 'ok', error_code = NULL, error_message = NULL, last_synced_at = datetime('now') WHERE item_id = ?")
      .bind(cursor || null, itemId).run();
    await log(env, itemId, 1, added, modified, removed, null);
    return { ok: true, added, modified, removed };
  } catch (e) {
    const code = e.plaid?.error_code || null;
    const st = code === "ITEM_LOGIN_REQUIRED" || code === "PENDING_EXPIRATION" ? "login_required" : "error";
    await env.DB.prepare("UPDATE items SET status = ?, error_code = ?, error_message = ? WHERE item_id = ?")
      .bind(st, code, (e.publicMessage || e.message || "").slice(0, 300), itemId).run();
    await log(env, itemId, 0, added, modified, removed, (code || e.message || "").slice(0, 300));
    return { ok: false, status: st, error: e.publicMessage || e.message };
  }
}

async function removeItem(env, itemId) {
  const item = await env.DB.prepare("SELECT access_token_enc FROM items WHERE item_id = ?").bind(itemId || "").first();
  if (!item) throw pub("That bank connection was not found.", 404);
  try { await plaid(env, "/item/remove", { access_token: await decrypt(env, item.access_token_enc) }); } catch (e) { console.warn(e.message); }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM balance_history WHERE account_id IN (SELECT account_id FROM accounts WHERE item_id = ?)").bind(itemId),
    env.DB.prepare("DELETE FROM transactions WHERE item_id = ?").bind(itemId),
    env.DB.prepare("DELETE FROM accounts WHERE item_id = ?").bind(itemId),
    env.DB.prepare("DELETE FROM items WHERE item_id = ?").bind(itemId),
  ]);
  return { removed: true };
}

async function updateAccount(env, { account_id, hidden, nickname }) {
  if (!account_id) throw pub("Missing account_id.", 400);
  await env.DB.prepare("UPDATE accounts SET hidden = COALESCE(?, hidden), nickname = COALESCE(?, nickname) WHERE account_id = ?")
    .bind(hidden == null ? null : (hidden ? 1 : 0), nickname == null ? null : String(nickname).slice(0, 60), account_id).run();
  return { ok: true };
}

async function status(env) {
  const items = (await env.DB.prepare("SELECT item_id, institution_name, status, error_code, error_message, last_synced_at, created_at FROM items ORDER BY created_at").all()).results;
  const accounts = (await env.DB.prepare("SELECT account_id, item_id, coalesce(nickname, name) AS name, mask, type, subtype, current, available, hidden FROM accounts ORDER BY type, name").all()).results;
  const tx = await env.DB.prepare("SELECT count(*) n, min(date) first, max(date) last FROM transactions").first();
  return { items, accounts, transactions: tx, env: env.PLAID_ENV || "production" };
}

/* ---------------- storage helpers ---------------- */

async function log(env, itemId, ok, a, m, r, detail) {
  await env.DB.prepare("INSERT INTO sync_log (item_id, ok, added, modified, removed, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(itemId, ok, a, m, r, detail).run();
  await env.DB.prepare("DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 500)").run();
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/* ---------------- encryption (AES-256-GCM) ---------------- */

let keyPromise;
function getKey(env) {
  if (!keyPromise) {
    const raw = (env.ENC_KEY || "").trim();
    if (!raw) throw pub("ENC_KEY is not set. Run: wrangler secret put ENC_KEY", 500);
    const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Uint8Array.from(raw.match(/../g).map(h => parseInt(h, 16)))
      : Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    if (bytes.length !== 32) throw pub("ENC_KEY must be 32 bytes (64 hex characters).", 500);
    keyPromise = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return keyPromise;
}
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function encrypt(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getKey(env), new TextEncoder().encode(plain));
  return `v1:${b64(iv)}:${b64(ct)}`;
}
async function decrypt(env, stored) {
  const [v, iv, ct] = String(stored).split(":");
  if (v !== "v1") throw pub("Stored token is in an unknown format.", 500);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await getKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

/* ---------------- responses ---------------- */

function pub(message, status = 400) { const e = new Error(message); e.publicMessage = message; e.status = status; return e; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function html(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.plaid.com; frame-src https://cdn.plaid.com; connect-src 'self' https://*.plaid.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'",
    },
  });
}

/* ---------------- the link page ---------------- */

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Household Finance · Bank links</title>
<style>
:root { --bg:#f2f4f3; --card:#fff; --ink:#17201d; --muted:#5d6b66; --line:#dde3e0; --accent:#1d6b57; --warn:#a8670b; --crit:#b33a2f; }
@media (prefers-color-scheme: dark) { :root { --bg:#111715; --card:#18201d; --ink:#e6ece9; --muted:#98a6a0; --line:#2a3531; --accent:#5cc0a2; --warn:#e0a54a; --crit:#ef7b6f; } }
* { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 16px; }
h1 { font-size: 24px; margin: 0; } .muted { color: var(--muted); font-size: 13.5px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: grid; gap: 10px; }
button, input { font: inherit; } input { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); width: 100%; }
button { padding: 9px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.item { border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: grid; gap: 6px; }
.acct { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; }
.ok { color: var(--accent); } .warn { color: var(--warn); } .crit { color: var(--crit); }
.hidden { display: none !important; }
</style></head><body><main>
<header><h1>Household bank links</h1><div class="muted">Links your accounts through Plaid. Balances and transactions sync every morning.</div></header>
<section class="card" id="lock"><label for="pin">PIN</label><input id="pin" type="password" autocomplete="current-password"><div class="row"><button class="primary" id="unlock">Unlock</button><span id="lockmsg" class="crit"></span></div></section>
<section class="card hidden" id="app">
  <div class="row"><button class="primary" id="link">Link a bank</button><button id="sync">Sync now</button><span id="msg" class="muted"></span></div>
  <div id="items"></div>
  <div class="muted" id="txinfo"></div>
</section>
</main>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
let PIN = sessionStorage.getItem("hf-pin") || "";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => n == null ? "—" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-pin": PIN }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("Error " + r.status));
  return d;
}
async function load() {
  try {
    const s = await api("/api/status");
    sessionStorage.setItem("hf-pin", PIN);
    $("lock").classList.add("hidden"); $("app").classList.remove("hidden");
    $("items").innerHTML = s.items.length ? s.items.map(it => {
      const accts = s.accounts.filter(a => a.item_id === it.item_id);
      const st = it.status === "ok" ? '<span class="ok">Connected</span>' : it.status === "login_required" ? '<span class="warn">Needs you to sign in again</span>' : '<span class="crit">Sync error</span>';
      return '<div class="item"><div class="row" style="justify-content:space-between"><strong>' + esc(it.institution_name || "Bank") + '</strong>' + st + '</div>'
        + accts.map(a => '<div class="acct"><span>' + esc(a.name) + (a.mask ? ' ••' + esc(a.mask) : '') + (a.hidden ? ' <span class="muted">(hidden)</span>' : '') + '</span><span>' + money(a.current) + ' <button data-hide="' + esc(a.account_id) + '" data-h="' + (a.hidden ? 0 : 1) + '">' + (a.hidden ? 'Show' : 'Hide') + '</button></span></div>').join("")
        + '<div class="muted">Last sync: ' + esc(it.last_synced_at ? it.last_synced_at + " UTC" : "never") + (it.error_message ? ' · ' + esc(it.error_message) : '') + '</div>'
        + '<div class="row">' + (it.status !== "ok" ? '<button class="primary" data-fix="' + esc(it.item_id) + '">Reconnect</button>' : '') + '<button data-rm="' + esc(it.item_id) + '">Remove</button></div></div>';
    }).join("") : '<p class="muted">No banks linked yet. Tap Link a bank.</p>';
    $("txinfo").textContent = s.transactions && s.transactions.n ? s.transactions.n + " transactions stored, " + s.transactions.first + " to " + s.transactions.last + ". Plaid: " + s.env + "." : "Plaid: " + s.env + ".";
  } catch (e) {
    $("lock").classList.remove("hidden"); $("app").classList.add("hidden");
    $("lockmsg").textContent = PIN ? e.message : "";
  }
}
async function openLink(itemId) {
  $("msg").textContent = "Opening Plaid…";
  try {
    const { link_token } = await api("/api/link-token", itemId ? { item_id: itemId } : {});
    const handler = Plaid.create({
      token: link_token,
      onSuccess: async (public_token, metadata) => {
        $("msg").textContent = "Saving and syncing… this can take a minute.";
        try {
          if (itemId) await api("/api/sync", { item_id: itemId });
          else await api("/api/exchange", { public_token, institution: metadata.institution });
          $("msg").textContent = "Done.";
        } catch (e) { $("msg").textContent = e.message; }
        load();
      },
      onExit: (err) => { $("msg").textContent = err ? (err.display_message || err.error_message || "Plaid closed.") : ""; },
    });
    handler.open();
  } catch (e) { $("msg").textContent = e.message; }
}
$("unlock").onclick = () => { PIN = $("pin").value; load(); };
$("pin").onkeydown = e => { if (e.key === "Enter") $("unlock").click(); };
$("link").onclick = () => openLink();
$("sync").onclick = async () => { $("msg").textContent = "Syncing…"; try { const r = await api("/api/sync"); $("msg").textContent = "Synced " + r.synced.length + " bank(s)."; } catch (e) { $("msg").textContent = e.message; } load(); };
document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.fix) openLink(b.dataset.fix);
  if (b.dataset.rm && confirm("Remove this bank and delete its stored data?")) { await api("/api/remove", { item_id: b.dataset.rm }).catch(x => alert(x.message)); load(); }
  if (b.dataset.hide) { await api("/api/account", { account_id: b.dataset.hide, hidden: b.dataset.h === "1" }).catch(x => alert(x.message)); load(); }
});
if (PIN) load();
</script></body></html>`;
