// Bunun deploy bot: deploy, restart, status and logs for the Coolify apps, from a private Telegram chat.
// It asks Telegram for new messages (long polling), so it needs no domain or open port.
// Settings come from environment variables; see .env.example.
import { createServer } from 'node:http';
import { dhaka, duration, escapeHtml, fitMessage, parseApps, parseIds, tidyLogs } from './format.mjs';

try {
  process.loadEnvFile();
} catch {
  // no .env file (Coolify sets real environment variables)
}

const env = process.env;
const TG = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
const COOLIFY = `${(env.COOLIFY_URL || 'http://13.140.173.69:8000').replace(/\/$/, '')}/api/v1`;
const APPS = parseApps(
  env.APPS ||
    'backend:kss2ucneseuomueurdbmysqa,admin:lu4ijxuv9xjccx5mu6k5sgq0,storefront:owxmr2x8cjhjnctsvrkgh5rx',
);
// Optional extra lock: when set, only these Telegram accounts may even try to sign in.
const ALLOWED = parseIds(env.ALLOWED_USER_IDS || '');
const API = (env.API_URL || 'https://kss2ucneseuomueurdbmysqa.13.140.173.69.sslip.io').replace(/\/$/, '');
const HEALTH_URL = env.HEALTH_URL || `${API}/health`;
const POLL_MS = 10_000;
const DEPLOY_TIMEOUT_MS = 30 * 60_000;
const LOGIN_TTL_MS = 5 * 60_000;

if (!env.TELEGRAM_BOT_TOKEN || !env.COOLIFY_TOKEN || !env.BOT_API_SECRET) {
  console.error('Set TELEGRAM_BOT_TOKEN, COOLIFY_TOKEN and BOT_API_SECRET.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appByName = (name) => APPS.find((a) => a.name === name?.toLowerCase());

// ---------- Telegram ----------

async function tg(method, params = {}) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(65_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram ${method}: ${body.description ?? res.status}`);
  return body.result;
}
const send = (chatId, html, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
const edit = (msg, html) =>
  tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: html, parse_mode: 'HTML' }).catch(
    () => send(msg.chat.id, html),
  );
const buttons = (action, withAll = false) => ({
  reply_markup: {
    inline_keyboard: [
      APPS.map((a) => ({ text: a.name, callback_data: `${action}:${a.name}` })),
      ...(withAll ? [[{ text: 'all (backend first)', callback_data: `${action}:all` }]] : []),
    ],
  },
});

// ---------- Coolify ----------

async function coolify(path, method = 'GET') {
  const res = await fetch(`${COOLIFY}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.COOLIFY_TOKEN}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new Error('Coolify refused the API token (expired or deleted?). Set a new COOLIFY_TOKEN.');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `Coolify ${method} ${path}: ${res.status}`), { status: res.status });
  return body;
}

/** Waits for a deployment (or restart) to end; returns the deployment record. */
async function waitFor(deploymentUuid) {
  const started = Date.now();
  while (Date.now() - started < DEPLOY_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const d = await coolify(`/deployments/${deploymentUuid}`).catch(() => null);
    if (d && !['queued', 'in_progress'].includes(d.status)) return d;
  }
  return { status: 'timed out (still running after 30 minutes)' };
}

/** The last visible lines of a deployment's build log, for a failure message. */
function buildTail(d, keep = 12) {
  try {
    const entries = JSON.parse(d.logs || '[]');
    return entries
      .filter((e) => !e.hidden && e.output)
      .map((e) => e.output.trim())
      .slice(-keep)
      .join('\n');
  } catch {
    return '';
  }
}

// ---------- Bunun API: who may use the bot ----------

async function api(path, body) {
  const res = await fetch(`${API}/api/v1/bot/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-secret': env.BOT_API_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => ({})) };
}

/** The owner signed in on this Telegram account, or null. Asked before every command. */
async function owner(telegramUserId) {
  const r = await api('session', { telegramUserId });
  if (r.status !== 200) throw new Error(`The store API refused the bot (${r.status}). Check BOT_API_SECRET on both.`);
  return r.body.owner;
}

const audit = (telegramUserId, action, app, result) =>
  api('audit', { telegramUserId, action, app, result }).catch((e) => console.warn('audit failed:', e.message));

// Sign-in conversations in progress: chat id → { step, email, password, until }. Memory only.
const logins = new Map();

const LOGIN_ERRORS = {
  INVALID_LOGIN: 'Email or password is incorrect.',
  INVALID_CODE: 'That code is not right.',
  ACCOUNT_LOCKED: 'Too many wrong attempts. Try again in 15 minutes.',
  ACCOUNT_DISABLED: 'This admin account has been disabled.',
  NOT_OWNER: 'Only the store owner can use this bot.',
  TWO_FACTOR_NOT_SET_UP: 'Sign in to the admin panel once to set up two-factor first.',
};

async function startLogin(chatId) {
  logins.set(chatId, { step: 'email', until: Date.now() + LOGIN_TTL_MS });
  await send(chatId, '🔐 Sign in with your Bunun admin account (owner only).\n\nYour admin <b>email</b>:\n\n/cancel to stop.');
}

/** One step of the sign-in conversation. */
async function loginStep(msg, state) {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();
  if (state.step === 'email') {
    Object.assign(state, { step: 'password', email: text });
    return send(chatId, 'Your admin <b>password</b> (I delete your message right after reading it):');
  }
  if (state.step === 'password') {
    // Bots may delete messages in private chats, so the password doesn't stay in the chat.
    await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    Object.assign(state, { step: 'code', password: text });
    return send(chatId, 'The 6-digit <b>code</b> from your authenticator app:');
  }
  logins.delete(chatId);
  const r = await api('link', { telegramUserId: msg.from.id, email: state.email, password: state.password, code: text });
  state.password = undefined;
  if (r.status === 200)
    return send(chatId, `✅ Signed in as <b>${escapeHtml(r.body.name)}</b> (${escapeHtml(r.body.email)}).\n\n${HELP}`);
  const why = LOGIN_ERRORS[r.body?.code] ?? escapeHtml(r.body?.message ?? `Sign-in failed (${r.status}).`);
  return send(chatId, `❌ ${why}\nSend /start to try again.`);
}

const busy = new Set();

/** Deploys (or restarts) one app and reports the result in the chat. Returns true on success. */
async function run(chatId, app, kind, userId) {
  if (busy.has(app.name)) {
    await send(chatId, `⏳ <b>${app.name}</b> is already deploying or restarting.`);
    return false;
  }
  busy.add(app.name);
  const verb = kind === 'restart' ? 'Restarting' : 'Deploying';
  const msg = await send(chatId, `🚀 ${verb} <b>${app.name}</b>…`);
  try {
    let started;
    if (kind === 'restart') {
      started = await coolify(`/applications/${app.uuid}/restart`, 'POST').catch((e) =>
        e.status === 404 || e.status === 405 ? coolify(`/applications/${app.uuid}/restart`) : Promise.reject(e),
      );
    } else {
      started = (await coolify(`/deploy?uuid=${app.uuid}`, 'POST')).deployments?.[0];
    }
    const id = started?.deployment_uuid;
    if (!id) {
      await edit(msg, `✅ ${app.name}: ${escapeHtml(started?.message ?? 'requested')}`);
      audit(userId, kind, app.name, 'requested');
      return true;
    }
    await edit(msg, `🚀 ${verb} <b>${app.name}</b>… (queued, I'll report back)`);
    const d = await waitFor(id);
    audit(userId, kind, app.name, `${d.status}${d.commit ? ` ${d.commit.slice(0, 7)}` : ''}`);
    if (d.status === 'finished') {
      const commit = d.commit ? ` · <code>${d.commit.slice(0, 7)}</code> ${escapeHtml(d.commit_message ?? '')}` : '';
      const took = d.created_at && d.updated_at ? ` in ${duration(d.created_at, d.updated_at)}` : '';
      await edit(msg, `✅ <b>${app.name}</b> ${kind === 'restart' ? 'restarted' : 'deployed'}${took}${commit}`);
      return true;
    }
    const tail = buildTail(d);
    await edit(
      msg,
      `❌ <b>${app.name}</b> ${kind} ${escapeHtml(d.status)}.` +
        (tail ? `\n<pre>${escapeHtml(fitMessage(tail, 3000))}</pre>` : '') +
        `\nMore: /logs ${app.name}`,
    );
    return false;
  } catch (e) {
    await edit(msg, `⚠️ ${app.name}: ${escapeHtml(e.message)}`);
    return false;
  } finally {
    busy.delete(app.name);
  }
}

async function deploy(chatId, target, userId) {
  if (target === 'all') {
    // The admin and storefront call the API, so the backend goes first.
    const backend = appByName('backend');
    if (backend && !(await run(chatId, backend, 'deploy', userId))) {
      await send(chatId, 'Stopped: the backend failed, so the others were not deployed.');
      return;
    }
    await Promise.all(APPS.filter((a) => a !== backend).map((a) => run(chatId, a, 'deploy', userId)));
    return;
  }
  const app = appByName(target);
  if (!app) return send(chatId, 'Which app?', buttons('deploy', true));
  await run(chatId, app, 'deploy', userId);
}

async function status(chatId) {
  const rows = await Promise.all(
    APPS.map(async (a) => {
      try {
        const [info, last] = await Promise.all([
          coolify(`/applications/${a.uuid}`),
          coolify(`/deployments/applications/${a.uuid}?take=1`),
        ]);
        const d = last.deployments?.[0];
        const icon = info.status?.startsWith('running') ? '🟢' : '🔴';
        const deployed = d
          ? `last deploy ${escapeHtml(d.status)} ${dhaka(d.updated_at)} · <code>${(d.commit ?? '').slice(0, 7)}</code>`
          : 'never deployed';
        return `${icon} <b>${a.name}</b> ${escapeHtml(info.status ?? '?')}\n    ${deployed}`;
      } catch (e) {
        return `⚠️ <b>${a.name}</b> ${escapeHtml(e.message)}`;
      }
    }),
  );
  const health = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000) })
    .then(async (r) => (r.ok ? `🟢 API health: ${escapeHtml(JSON.stringify(await r.json()))}` : `🔴 API health: ${r.status}`))
    .catch((e) => `🔴 API health: ${escapeHtml(e.message)}`);
  await send(chatId, [...rows, health].join('\n'));
}

async function logs(chatId, target) {
  const app = appByName(target);
  if (!app) return send(chatId, 'Logs of which app?', buttons('logs'));
  try {
    const { logs: raw } = await coolify(`/applications/${app.uuid}/logs?lines=300`);
    const text = tidyLogs(raw, 30) || '(no log lines apart from health checks)';
    await send(chatId, `📄 <b>${app.name}</b>, latest lines (UTC):\n<pre>${escapeHtml(fitMessage(text))}</pre>`);
  } catch (e) {
    await send(chatId, `⚠️ ${escapeHtml(e.message)}`);
  }
}

const HELP = [
  '<b>Bunun deploy bot</b>',
  `/deploy &lt;${APPS.map((a) => a.name).join('|')}|all&gt; — pull the latest code from GitHub, build and start it`,
  '/restart &lt;app&gt; — restart without rebuilding',
  '/status — what is running and the last deploy of each app',
  '/logs &lt;app&gt; — the latest log lines',
  '/logout — sign this Telegram account out',
  'Leave out the app to get buttons.',
].join('\n');

/** Commands for a signed-in owner. */
async function command(chatId, text, userId) {
  const [cmd, arg] = text.trim().split(/\s+/);
  switch (cmd.replace(/@.*$/, '').toLowerCase()) {
    case '/deploy':
    case '/redeploy':
      return deploy(chatId, arg?.toLowerCase(), userId);
    case '/restart': {
      const app = appByName(arg);
      return app ? run(chatId, app, 'restart', userId) : send(chatId, 'Restart which app?', buttons('restart'));
    }
    case '/logout':
      await api('unlink', { telegramUserId: userId });
      return send(chatId, '👋 Signed out. Send /start to sign in again.');
    case '/status':
      return status(chatId);
    case '/logs':
      return logs(chatId, arg);
    default:
      return send(chatId, HELP);
  }
}

// ---------- Main loop ----------

async function handle(update) {
  const msg = update.message ?? update.callback_query?.message;
  const from = update.message?.from ?? update.callback_query?.from;
  if (!msg || !from || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  if (ALLOWED.size > 0 && !ALLOWED.has(from.id)) {
    // Not on the optional allow-list: no reply at all.
    console.warn(`ignored a message from Telegram user ${from.id}`);
    return;
  }

  if (update.callback_query) {
    await tg('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {});
    if (!(await owner(from.id))) return send(chatId, 'Please sign in first: /start');
    const [action, target] = update.callback_query.data.split(':');
    if (action === 'deploy') return deploy(chatId, target, from.id);
    if (action === 'restart' && appByName(target)) return run(chatId, appByName(target), 'restart', from.id);
    if (action === 'logs') return logs(chatId, target);
    return;
  }

  // Messages sent while the bot was down are skipped, so an old /deploy doesn't fire by surprise.
  if (Date.now() / 1000 - msg.date > 120 || !msg.text) return;
  const text = msg.text.trim();
  const cmd = text.split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();

  if (cmd === '/cancel') {
    logins.delete(chatId);
    return send(chatId, 'Cancelled.');
  }
  const state = logins.get(chatId);
  if (state && state.until < Date.now()) logins.delete(chatId);
  else if (state && !text.startsWith('/')) return loginStep(msg, state);

  const me = await owner(from.id);
  if (cmd === '/start' || cmd === '/login' || !me) {
    if (me) return send(chatId, `Signed in as <b>${escapeHtml(me.name)}</b>.\n\n${HELP}`);
    return startLogin(chatId);
  }
  await command(chatId, text, from.id);
}

// Coolify checks that the container answers on its port.
createServer((_req, res) => res.end('ok')).listen(Number(env.PORT) || 3000);

await tg('setMyCommands', {
  commands: [
    { command: 'deploy', description: 'Deploy the latest code (backend, admin, storefront or all)' },
    { command: 'restart', description: 'Restart an app without rebuilding' },
    { command: 'status', description: 'What is running, last deploys, API health' },
    { command: 'logs', description: 'Latest log lines of an app' },
    { command: 'logout', description: 'Sign this Telegram account out' },
  ],
}).catch((e) => console.warn(e.message));
console.log(`deploy bot started; allow-list: ${ALLOWED.size || 'off'}; apps: ${APPS.map((a) => a.name).join(', ')}`);

let offset = 0;
for (;;) {
  try {
    const updates = await tg('getUpdates', {
      offset,
      timeout: 50,
      allowed_updates: ['message', 'callback_query'],
    });
    for (const u of updates) {
      offset = u.update_id + 1;
      // Not awaited: a 5-minute deploy must not block other commands.
      handle(u).catch((e) => {
        console.error('update failed:', e.message);
        const chatId = (u.message ?? u.callback_query?.message)?.chat.id;
        if (chatId) send(chatId, `⚠️ ${escapeHtml(e.message)}`).catch(() => {});
      });
    }
  } catch (e) {
    console.error('polling:', e.message);
    await sleep(5_000);
  }
}
