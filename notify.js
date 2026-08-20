// anti-DDoSia — alert delivery (in-app is just the DB; here: webhook + email)
//
// Email uses a tiny dependency-free SMTP client (node:net / node:tls),
// configured via env: SMTP_HOST, SMTP_PORT (default 587), SMTP_USER,
// SMTP_PASS, SMTP_FROM, SMTP_SECURE=true (implicit TLS, e.g. port 465).
// If SMTP_HOST is unset, email is silently skipped.

import net from 'node:net';
import tls from 'node:tls';

const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
  secure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE || ''),
};
export const emailConfigured = () => !!SMTP.host;
export const appBaseUrl = () => process.env.APP_URL || 'http://localhost:3000';

// Reject webhook URLs that point at internal/reserved space (SSRF guard).
// Note: this blocks literal private IPs and internal hostnames at save
// time; it does not defeat DNS-rebinding — for hostile multi-tenant use,
// pair it with an egress allowlist / at-send DNS pinning.
export function webhookUrlIssue(url) {
  let u;
  try { u = new URL(url); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must be an http(s) URL';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'internal hosts are not allowed';
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return 'invalid IP';
    if (o[0] === 10 || o[0] === 127 || o[0] === 0 || (o[0] === 169 && o[1] === 254) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || o[0] >= 224) return 'private/reserved IPs are not allowed';
  }
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:')) return 'private IPv6 is not allowed';
  return null;
}
const stripCrlf = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

// ---------- webhook ----------
export async function sendWebhook(url, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'anti-ddosia-alert/1.0' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.error('[notify] webhook failed:', e.message);
    return false;
  } finally { clearTimeout(t); }
}

// ---------- minimal SMTP ----------
function smtpSession(socket) {
  let buf = '';
  const waiters = [];
  socket.setEncoding('utf8');
  socket.on('data', (d) => {
    buf += d;
    let idx;
    // A complete reply ends with a line "NNN <text>" (space after code).
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (/^\d{3} /.test(line) && waiters.length) waiters.shift()(line);
    }
  });
  return {
    read: () => new Promise((res) => waiters.push(res)),
    send: (line) => socket.write(line + '\r\n'),
  };
}
async function expect(sess, code) {
  const line = await sess.read();
  if (!line.startsWith(String(code))) throw new Error(`SMTP expected ${code}, got: ${line}`);
  return line;
}

export async function sendEmail(to, subject, text) {
  if (!SMTP.host) return false;
  // header-injection guard: no CRLF in envelope/header fields
  to = stripCrlf(to); subject = stripCrlf(subject).slice(0, 200);
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    const connect = SMTP.secure ? tls.connect : net.connect;
    const socket = connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host }, async () => {
      try {
        let sess = smtpSession(socket);
        await expect(sess, 220);
        sess.send(`EHLO anti-ddosia`); await expect(sess, 250);

        let sock = socket;
        if (!SMTP.secure) {
          sess.send('STARTTLS'); await expect(sess, 220);
          sock = tls.connect({ socket, servername: SMTP.host });
          await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
          sess = smtpSession(sock);
          sess.send('EHLO anti-ddosia'); await expect(sess, 250);
        }

        if (SMTP.user) {
          sess.send('AUTH LOGIN'); await expect(sess, 334);
          sess.send(Buffer.from(SMTP.user).toString('base64')); await expect(sess, 334);
          sess.send(Buffer.from(SMTP.pass).toString('base64')); await expect(sess, 235);
        }
        sess.send(`MAIL FROM:<${SMTP.from}>`); await expect(sess, 250);
        sess.send(`RCPT TO:<${to}>`); await expect(sess, 250);
        sess.send('DATA'); await expect(sess, 354);
        const msg = [
          `From: anti-DDoSia <${SMTP.from}>`,
          `To: ${to}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '', text, '',
        ].join('\r\n');
        sock.write(msg.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
        await expect(sess, 250);
        sess.send('QUIT');
        sock.end();
        resolve(true);
      } catch (e) { socket.destroy(); reject(e); }
    });
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('SMTP timeout')); });
    socket.on('error', onErr);
  });
}

// ---------- high-level fan-out ----------
export async function deliverAlert(user, alert) {
  const line = `Your asset "${alert.asset_value}" is on the DDoSia target list: ${alert.target_host} (${alert.target_ips}) — ${alert.vectors} attack vector(s) [${alert.types}].`;
  const payload = {
    event: 'ddosia_target_match',
    asset: alert.asset_value,
    target_host: alert.target_host,
    target_ips: alert.target_ips,
    vectors: alert.vectors,
    types: alert.types,
    matched_at: alert.first_matched,
    dashboard: appBaseUrl(),
  };
  if (user.webhook_url) sendWebhook(user.webhook_url, payload);
  if (user.email_alerts && emailConfigured()) {
    sendEmail(user.email, `[anti-DDoSia] Target match: ${alert.target_host}`,
      `${line}\n\nMatched: ${alert.first_matched}\nDashboard: ${appBaseUrl()}\n\n— anti-DDoSia monitor`)
      .catch((e) => console.error('[notify] email failed:', e.message));
  }
}
