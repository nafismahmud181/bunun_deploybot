// Pure helpers (no network), so they can be tested on their own.

/** Parses "backend:uuid,admin:uuid" into [{ name, uuid }]. */
export function parseApps(spec) {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, uuid] = s.split(':').map((p) => p.trim());
      if (!name || !uuid) throw new Error(`APPS entry "${s}" must look like name:uuid`);
      return { name, uuid };
    });
}

/** Comma-separated Telegram user IDs allowed to use the bot. */
export const parseIds = (spec) =>
  new Set(
    spec
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number),
  );

export const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** "3m 12s" between two ISO dates. */
export function duration(from, to) {
  const s = Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Bangladesh time, e.g. "10 Oct, 02:41". */
export const dhaka = (iso) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };

/**
 * Turns container logs into short readable lines. JSON (pino) lines become "time LEVEL message";
 * health-check requests are dropped, since they are most of the backend's log.
 */
export function tidyLogs(raw, keep = 30) {
  const lines = String(raw ?? '')
    .split('\n')
    .filter((l) => l.trim());
  const healthReqs = new Set();
  const out = [];
  for (const line of lines) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (j?.req?.url === '/health' || j?.req?.url === '/api/health') {
      healthReqs.add(j.reqId);
      continue;
    }
    if (j?.reqId && healthReqs.has(j.reqId)) continue;
    const time = typeof j.time === 'number' ? new Date(j.time).toISOString().slice(11, 19) : '';
    const level = LEVELS[j.level] ?? j.level ?? '';
    const extra = j.req ? ` ${j.req.method} ${j.req.url}` : j.res ? ` ${j.res.statusCode}` : '';
    const err = j.err?.message ? ` — ${j.err.message}` : '';
    out.push(`${time} ${level} ${j.msg ?? ''}${extra}${err}`.trim());
  }
  return out.slice(-keep).join('\n');
}

/** Telegram allows 4096 characters per message; keep the end, where the newest lines are. */
export const fitMessage = (text, max = 3800) => (text.length > max ? '…' + text.slice(-max) : text);
