/**
 * proxyUtils.js — Universal proxy support for all formats and protocols.
 *
 * FIXED:
 *   - ProxyRotator.stats() method added (was missing → crash)
 *   - ProxyRotator.ban()   method added (was missing → crash)
 *   - Banned proxies are tracked and excluded from rotation
 *   - hpagent require wrapped safely (optional dependency)
 *   - Better error handling throughout
 */

const dns              = require('dns').promises;
const { SocksProxyAgent } = require('socks-proxy-agent');
const net              = require('net');

// ── Format normalizer ────────────────────────────────────────────────────────

function normalizeProxy(raw) {
  if (!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  if (!raw) return null;

  const KNOWN_SCHEMES = ['socks5h://', 'socks5://', 'socks4a://', 'socks4://', 'http://', 'https://'];
  for (const scheme of KNOWN_SCHEMES) {
    if (raw.toLowerCase().startsWith(scheme)) {
      try { new URL(raw); return raw; } catch (_) { return null; }
    }
  }

  // Format: host:port:user:pass
  const hostPortUserPass = raw.match(/^([^:@\s]+):(\d+):([^:@\s]+):([^:@\s]+)$/);
  if (hostPortUserPass) {
    const [, host, port, user, pass] = hostPortUserPass;
    return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Format: user:pass@host:port
  const userPassAtHostPort = raw.match(/^([^@\s]+):([^@\s]+)@([^:@\s]+):(\d+)$/);
  if (userPassAtHostPort) {
    const [, user, pass, host, port] = userPassAtHostPort;
    return `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  // Try wrapping as socks5h
  try {
    const attempt = `socks5h://${raw}`;
    new URL(attempt);
    return attempt;
  } catch (_) {}

  console.warn(`[proxyUtils] Cannot normalize: ${raw.substring(0, 60)}`);
  return null;
}

function parseProxyList(text) {
  if (!text) return [];
  const lines = Array.isArray(text) ? text : text.split('\n');
  return lines.map(l => normalizeProxy(l.trim())).filter(Boolean);
}

// ── Agent factory ────────────────────────────────────────────────────────────

async function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;

  const normalized = normalizeProxy(proxyUrl);
  if (!normalized) {
    console.warn(`[proxyUtils] makeProxyAgent: bad proxy URL`);
    return null;
  }

  let parsed;
  try { parsed = new URL(normalized); }
  catch (err) { console.warn(`[proxyUtils] URL parse failed: ${err.message}`); return null; }

  const scheme = parsed.protocol;

  // HTTP / HTTPS proxy
  if (scheme === 'http:' || scheme === 'https:') {
    try {
      const { HttpsProxyAgent } = require('hpagent');
      return new HttpsProxyAgent({ proxy: normalized, timeout: 15000 });
    } catch (_) {
      return null; // hpagent not available
    }
  }

  // SOCKS proxy — resolve hostname to IP if needed
  const proxyHost = parsed.hostname;
  const isIp = net.isIP(proxyHost) !== 0;
  let agentUrl = normalized;

  if (!isIp) {
    try {
      const result = await dns.lookup(proxyHost, { family: 4 });
      const withIp = new URL(normalized);
      withIp.hostname = result.address;
      agentUrl = withIp.toString();
    } catch (dnsErr) {
      console.warn(`[proxyUtils] DNS resolve failed for ${proxyHost}: ${dnsErr.message}`);
    }
  }

  try {
    return new SocksProxyAgent(agentUrl, { timeout: 15000 });
  } catch (err) {
    console.warn(`[proxyUtils] SocksProxyAgent failed: ${err.message}`);
    return null;
  }
}

// ── Live proxy tester ────────────────────────────────────────────────────────

async function testProxy(proxyUrl) {
  const normalized = normalizeProxy(proxyUrl);
  if (!normalized) {
    return { success: false, message: `❌ Cannot parse proxy format: ${proxyUrl}` };
  }

  const start = Date.now();
  try {
    const agent = await makeProxyAgent(normalized);
    if (!agent) {
      return { success: false, message: `❌ Could not create proxy agent` };
    }

    const result = await new Promise((resolve, reject) => {
      const https = require('https');
      const req = https.get('https://api.ipify.org?format=json', { agent, timeout: 12000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ ip: JSON.parse(data).ip }); }
          catch (_) { resolve({ ip: data.trim() }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 12s')); });
    });

    const latencyMs = Date.now() - start;
    const masked = `${parsed.protocol}//*:****@${parsed.hostname}:${parsed.port}`;
    return { success: true, message: `✅ Proxy works! Exit IP: ${result.ip} | ${latencyMs}ms`, ip: result.ip, latencyMs };

  } catch (err) {
    const latencyMs = Date.now() - start;
    return { success: false, message: `❌ Proxy failed (${latencyMs}ms): ${err.message}`, latencyMs };
  }
}

// ── Proxy Rotator ────────────────────────────────────────────────────────────

/**
 * ProxyRotator — round-robin proxy selection with ban tracking.
 *
 * FIXED: Added stats() and ban() methods that were missing and caused crashes.
 *
 * Methods:
 *   .next()         → next proxy URL (skips banned ones)
 *   .ban(url)       → mark a proxy as banned (IP got blocked by game server)
 *   .stats()        → { total, active, banned } counts
 *   .summary()      → human-readable string
 *   .enabled        → true if any proxies loaded
 */
class ProxyRotator {
  constructor(proxyList = []) {
    this.all    = parseProxyList(
      Array.isArray(proxyList) ? proxyList.join('\n') : (proxyList || '')
    );
    this.banned = new Set(); // banned proxy URLs
    this.index  = 0;
    console.log(`[ProxyRotator] Loaded ${this.all.length} proxies`);
  }

  get enabled() { return this.all.length > 0; }

  /** Returns list of currently-active (not-banned) proxies */
  get _active() {
    return this.all.filter(p => !this.banned.has(p));
  }

  /**
   * next() → next non-banned proxy URL, or null if none available
   */
  next() {
    if (!this.enabled) return null;
    const active = this._active;
    if (active.length === 0) {
      console.warn('[ProxyRotator] All proxies are banned — using direct connection');
      return null;
    }
    const proxy = active[this.index % active.length];
    this.index++;
    return proxy;
  }

  /**
   * ban(proxyUrl) — mark proxy as banned so it's skipped in future rotations.
   * Called when game server returns result=-1 (IP banned).
   */
  ban(proxyUrl) {
    if (!proxyUrl) return;
    const normalized = normalizeProxy(proxyUrl) || proxyUrl;
    this.banned.add(normalized);
    console.log(`[ProxyRotator] Banned proxy. Active: ${this._active.length}/${this.all.length}`);
  }

  /**
   * stats() → { total, active, banned }
   * Called by processors to display proxy pool status in the terminal.
   */
  stats() {
    return {
      total:  this.all.length,
      active: this._active.length,
      banned: this.banned.size,
    };
  }

  /**
   * summary() → human-readable string for startup log
   */
  summary() {
    const s = this.stats();
    return `${s.total} proxies loaded (${s.active} active, ${s.banned} banned)`;
  }
}

module.exports = { normalizeProxy, parseProxyList, makeProxyAgent, testProxy, ProxyRotator };
