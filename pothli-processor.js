/**
 * pothli-processor.js
 *
 * Claims the daily Pothli/Theli gift bag for each account.
 *
 * Protocol (verified from Electron app):
 *   1. Login
 *      SEND: { account, password, version:'2.0.1', mainID:100, subID:6 }
 *      RECV: { mainID:100, subID:116, data:{ userid, dynamicpass, score, ... } }
 *
 *   2. Claim Pothli
 *      SEND: { userid, dynamicpass, mainID:100, subID:29 }
 *      RECV: { mainID:100, subID:145, data:{ result:0, score, ... } }
 *            result=0 → claimed successfully
 *            result≠0 → already claimed / not available
 *
 * Error codes:
 *   result=-1  → IP banned — ban proxy, skip account
 *   result=3   → wrong credentials — skip, no retry
 *   result=6   → account locked
 *
 * LOGIN_WS_URL and ORIGIN are overwritten at runtime by the game selector.
 */

const WebSocket    = require('ws');
const EventEmitter = require('events');
const { makeProxyAgent, ProxyRotator } = require('./proxyUtils');

class PothliProcessor extends EventEmitter {
  constructor(db) {
    super();
    this.db              = db;
    this.isProcessing    = false;
    this.currentAccounts = [];
    this.processingIndex = 0;

    this.totalCycles  = 1;
    this.currentCycle = 0;

    this.proxyRotator = new ProxyRotator([]);

    this.stats = {
      successCount:    0,
      failCount:       0,
      pothliClaimed:   0,
      alreadyClaimed:  0,
      totalScoreWon:   0,
      activeWorkers:   0,
      cyclesCompleted: 0,
      ipBannedSkipped: 0,
      wrongPassSkipped: 0,
    };

    this.config = {
      LOGIN_WS_URL:  'wss://pandamaster.vip:7878/',
      GAME_VERSION:  '2.0.1',
      ORIGIN:        'http://play.pandamaster.vip',
      BATCH_SIZE:    5,
      RETRY_ATTEMPTS: 2,
      RANDOM_DELAYS: { MIN: 600, MAX: 2000 },
      CYCLE_DELAY:   { MIN: 3000, MAX: 8000 },
      TIMEOUTS:      { TOTAL: 35000 },
    };

    this.userAgents = [
      'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
    ];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async startProcessing(accountIds, repetitions = 1, useProxy = false, proxyList = []) {
    if (this.isProcessing) throw new Error('Already processing');

    this.isProcessing    = true;
    this.processingIndex = 0;
    this.totalCycles     = Math.max(1, Math.min(50, parseInt(repetitions) || 1));
    this.currentCycle    = 0;
    this.proxyRotator    = new ProxyRotator(proxyList);

    this.stats = {
      successCount: 0, failCount: 0, pothliClaimed: 0,
      alreadyClaimed: 0, totalScoreWon: 0, activeWorkers: 0,
      cyclesCompleted: 0, ipBannedSkipped: 0, wrongPassSkipped: 0,
    };

    const all = await this.db.getAllAccounts();
    this.currentAccounts = all.filter(a => accountIds.includes(a.id));

    this._emit('terminal', { type: 'info', message: '🎁 POTHLI CLAIM BOT STARTED' });
    this._emit('terminal', { type: 'info', message: `📋 Accounts: ${this.currentAccounts.length} | Cycles: ${this.totalCycles}` });
    this._emit('terminal', { type: 'info', message: `🌐 Server: ${this.config.LOGIN_WS_URL}` });
    this._emit('terminal', { type: 'info', message: `🔗 Origin: ${this.config.ORIGIN}` });
    this._emit('terminal', { type: 'info', message: `🛡️ Proxy: ${this.proxyRotator.enabled ? this.proxyRotator.summary() : 'disabled'}` });
    this._emit('status',   { running: true, total: this.currentAccounts.length, current: 0, activeWorkers: 0 });

    this._runCycles();
    return { started: true, totalAccounts: this.currentAccounts.length, totalCycles: this.totalCycles };
  }

  async stopProcessing() {
    this.isProcessing = false;
    this._emit('terminal', { type: 'warning', message: '🛑 Processing stopped' });
    this._emit('status',   { running: false, activeWorkers: 0 });
    return { success: true };
  }

  // ── Cycle loop ──────────────────────────────────────────────────────────────

  async _runCycles() {
    while (this.isProcessing && this.currentCycle < this.totalCycles) {
      this.currentCycle++;
      this.processingIndex = 0;

      const sep = '─'.repeat(55);
      this._emit('terminal', { type: 'info',
        message: `\n${sep}\n🔄 CYCLE ${this.currentCycle}/${this.totalCycles}\n${sep}` });

      await this._processBatches();

      this.stats.cyclesCompleted = this.currentCycle;
      this._emit('cycleUpdate', {
        cyclesCompleted: this.currentCycle, totalCycles: this.totalCycles,
        successCount: this.stats.successCount, failCount: this.stats.failCount,
        pothliClaimed: this.stats.pothliClaimed, totalScoreWon: this.stats.totalScoreWon,
      });
      this._emit('terminal', { type: 'success',
        message: `✅ Cycle ${this.currentCycle} done | Claimed: ${this.stats.pothliClaimed} | Score: ${this.stats.totalScoreWon}` });

      if (this.isProcessing && this.currentCycle < this.totalCycles) {
        const delay = this._rand(this.config.CYCLE_DELAY.MIN, this.config.CYCLE_DELAY.MAX);
        this._emit('terminal', { type: 'info', message: `⏳ Waiting ${delay}ms before next cycle...` });
        await this._sleep(delay);
      }
    }
    this._complete();
  }

  async _processBatches() {
    const total = this.currentAccounts.length;
    while (this.isProcessing && this.processingIndex < total) {
      const start = this.processingIndex;
      const end   = Math.min(start + this.config.BATCH_SIZE, total);
      const batch = this.currentAccounts.slice(start, end);

      this._emit('terminal', { type: 'info',
        message: `🔄 Batch ${Math.floor(start / this.config.BATCH_SIZE) + 1}: Accounts ${start + 1}–${end}` });

      if (this.proxyRotator.stats().banned > 0) {
        const ps = this.proxyRotator.stats();
        this._emit('terminal', { type: 'warning',
          message: `🛡️ Proxy pool: ${ps.active}/${ps.total} active (${ps.banned} banned)` });
      }

      await Promise.allSettled(batch.map((acc, i) => this._processWithRetry(acc, start + i)));
      this.processingIndex = end;

      if (this.isProcessing && end < total) {
        await this._sleep(this._rand(this.config.RANDOM_DELAYS.MIN, this.config.RANDOM_DELAYS.MAX));
      }
    }
  }

  async _processWithRetry(account, globalIndex, attempt = 0) {
    this.stats.activeWorkers++;
    this._emit('status', {
      running: true, total: this.currentAccounts.length,
      current: globalIndex + 1, activeWorkers: this.stats.activeWorkers,
      currentAccount: account.username,
      currentCycle: this.currentCycle, totalCycles: this.totalCycles,
    });

    try {
      const result = await this._accountFlow(account, globalIndex, attempt);

      if (result.ipBanned) {
        this.stats.ipBannedSkipped++;
        this.stats.failCount++;
        this._emitProgress(globalIndex, account, false, result.error);
        return result;
      }

      if (result.wrongPassword) {
        this.stats.wrongPassSkipped++;
        this.stats.failCount++;
        this._emitProgress(globalIndex, account, false, result.error);
        return result;
      }

      if (!result.success && attempt < this.config.RETRY_ATTEMPTS) {
        this._log(globalIndex, 'warning', `🔄 Retry ${attempt + 1}/${this.config.RETRY_ATTEMPTS}`);
        await this._sleep(this._rand(this.config.RANDOM_DELAYS.MIN, this.config.RANDOM_DELAYS.MAX));
        return this._processWithRetry(account, globalIndex, attempt + 1);
      }

      if (result.newScore !== undefined) {
        await this.db.updateAccount({ ...account, score: result.newScore });
      }
      await this.db.addProcessingLog(
        account.id,
        result.success ? 'success' : 'error',
        result.success
          ? `Pothli: ${result.pothliClaimed ? `+${result.scoreWon || 0}` : 'already claimed'}`
          : result.error,
        result
      );

      if (result.success) {
        this.stats.successCount++;
        if (result.pothliClaimed) {
          this.stats.pothliClaimed++;
          this.stats.totalScoreWon += result.scoreWon || 0;
        } else {
          this.stats.alreadyClaimed++;
        }
      } else {
        this.stats.failCount++;
      }

      this._emitProgress(globalIndex, account, result.success, result.error);
      return result;

    } catch (err) {
      this._log(globalIndex, 'error', `❌ Unexpected: ${err.message}`);
      this.stats.failCount++;
      return { success: false, error: err.message };
    } finally {
      this.stats.activeWorkers--;
    }
  }

  // ── Core flow ───────────────────────────────────────────────────────────────

  _accountFlow(account, index, attempt = 0) {
    return new Promise(async (resolve) => {
      let ws           = null;
      let usedProxyUrl = null;

      let phase       = 'login';
      let loginDone   = false;
      let claimed     = false;
      let lastScore   = account.score || 0;
      let originalScore = account.score || 0;

      this._log(index, 'info', `🔄 ${account.username}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

      const hardTimeout = setTimeout(() => {
        this._log(index, 'warning', `⏰ Timeout`);
        cleanup();
        resolve({ success: false, error: 'Timeout', newScore: lastScore });
      }, this.config.TIMEOUTS.TOTAL);

      const cleanup = () => {
        clearTimeout(hardTimeout);
        try {
          if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING)
            ws.terminate();
        } catch (_) {}
      };

      const done = (result) => {
        if (phase === 'done') return;
        phase = 'done';
        cleanup();
        resolve(result);
      };

      // Proxy
      let agent = null;
      if (this.proxyRotator.enabled) {
        usedProxyUrl = this.proxyRotator.next();
        if (usedProxyUrl) {
          try {
            agent = await makeProxyAgent(usedProxyUrl);
            if (agent) this._log(index, 'debug', `🛡️ Proxy: ${usedProxyUrl.replace(/\/\/[^@]+@/, '//*:****@')}`);
            else { this._log(index, 'warning', `⚠️ Proxy agent failed, direct`); usedProxyUrl = null; }
          } catch (e) {
            this._log(index, 'warning', `⚠️ Proxy err: ${e.message}`); usedProxyUrl = null;
          }
        }
      }

      const wsOptions = {
        handshakeTimeout: 12000,
        headers: { 'User-Agent': this._ua(), 'Origin': this.config.ORIGIN },
      };
      if (agent) wsOptions.agent = agent;

      try {
        ws = new WebSocket(this.config.LOGIN_WS_URL, ['wl'], wsOptions);
      } catch (err) {
        return resolve({ success: false, error: `WS error: ${err.message}` });
      }

      ws.on('open', () => {
        this._log(index, 'success', `✅ Connected`);
        ws.send(JSON.stringify({
          account: account.username, password: account.password,
          version: this.config.GAME_VERSION, mainID: 100, subID: 6,
        }));
      });

      ws.on('message', (raw) => {
        if (phase === 'done') return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

        this._log(index, 'debug', `📩 subID:${msg.subID} phase:${phase}`);

        // ── Login response ──────────────────────────────────────────────────
        if (msg.subID === 116 && !loginDone) {
          const d = msg.data || {};

          if (d.result === -1) {
            const ip = ((d.msg || '').match(/\(([^)]+)\)/) || [])[1] || 'unknown';
            this._log(index, 'error', `🚫 IP banned: ${ip} — removing proxy`);
            if (usedProxyUrl) this.proxyRotator.ban(usedProxyUrl);
            const ps = this.proxyRotator.stats();
            this._log(index, 'warning', `🛡️ Pool: ${ps.active}/${ps.total} active`);
            return done({ success: false, ipBanned: true, error: `Proxy IP ${ip} banned` });
          }

          if (d.result === 3) {
            this._log(index, 'error', `❌ Wrong credentials — skip`);
            return done({ success: false, wrongPassword: true, error: 'Wrong username/password' });
          }

          if (d.result === 6) {
            this._log(index, 'error', `❌ Account locked`);
            return done({ success: false, wrongPassword: true, error: 'Account locked' });
          }

          if (!d.userid || !d.dynamicpass) {
            this._log(index, 'error', `❌ Login failed result=${d.result}`);
            return done({ success: false, error: `Login rejected (result:${d.result})` });
          }

          account.userid      = d.userid;
          account.dynamicpass = d.dynamicpass;
          lastScore           = d.score !== undefined ? d.score : lastScore;
          originalScore       = lastScore;
          loginDone           = true;
          this._log(index, 'success', `✅ ${d.nickname || account.username} | score: ${lastScore}`);

          // Claim pothli
          phase = 'claim';
          ws.send(JSON.stringify({
            userid:      account.userid,
            dynamicpass: account.dynamicpass,
            mainID:      100,
            subID:       29,
          }));
          return;
        }

        // ── Pothli claim response ───────────────────────────────────────────
        if (msg.subID === 145 && phase === 'claim') {
          const d = msg.data || {};
          claimed = true;

          if (d.result === 0) {
            const newBal  = d.score !== undefined ? d.score : lastScore;
            const scoreWon = newBal - originalScore;
            this._log(index, 'success', `🎁 Pothli claimed! +${scoreWon} | balance: ${newBal}`);
            return setTimeout(() => done({
              success: true, pothliClaimed: true,
              scoreWon, newScore: newBal,
            }), 300);
          } else {
            this._log(index, 'warning', `⚠️ Pothli result=${d.result} (${d.msg || 'already claimed or unavailable'})`);
            return setTimeout(() => done({
              success: true, pothliClaimed: false,
              message: d.msg || 'Not available', newScore: lastScore,
            }), 300);
          }
        }
      });

      ws.on('error', (err) => {
        this._log(index, 'error', `❌ WS: ${err.message}`);
        done({ success: false, error: err.message });
      });

      ws.on('close', (code) => {
        if (phase !== 'done') {
          this._log(index, 'debug', `WS closed code:${code} phase:${phase}`);
          done({ success: false, error: `Connection closed (${code})` });
        }
      });
    });
  }

  // ── Completion ──────────────────────────────────────────────────────────────

  _complete() {
    this.isProcessing = false;
    const ps = this.proxyRotator.stats();

    this._emit('terminal', { type: 'success', message: '\n🎉 POTHLI PROCESSING COMPLETED!' });
    this._emit('terminal', { type: 'info',    message: `📈 Success: ${this.stats.successCount} | Failed: ${this.stats.failCount}` });
    this._emit('terminal', { type: 'info',    message: `🎁 Pothli claimed: ${this.stats.pothliClaimed} | Already claimed: ${this.stats.alreadyClaimed}` });
    this._emit('terminal', { type: 'info',    message: `💰 Total score won: ${this.stats.totalScoreWon}` });
    if (this.stats.ipBannedSkipped > 0)
      this._emit('terminal', { type: 'warning', message: `🚫 IP banned skipped: ${this.stats.ipBannedSkipped}` });
    if (this.stats.wrongPassSkipped > 0)
      this._emit('terminal', { type: 'warning', message: `🔑 Wrong password skipped: ${this.stats.wrongPassSkipped}` });
    if (ps.banned > 0)
      this._emit('terminal', { type: 'warning', message: `🛡️ ${ps.banned} proxy IPs banned. Replace with fresh proxies.` });

    this._emit('completed', { ...this.stats });
    this._emit('status',   { running: false, activeWorkers: 0 });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _emit(event, data) { this.emit(event, data); }

  _log(index, type, message) {
    this.emit('terminal', { type, message: `[${index}] ${message}`, timestamp: new Date().toISOString() });
  }

  _emitProgress(index, account, success, error) {
    this._emit('progress', {
      index, total: this.currentAccounts.length,
      account: account.username, success, error,
      stats: { ...this.stats },
    });
  }

  _ua()              { return this.userAgents[Math.floor(Math.random() * this.userAgents.length)]; }
  _rand(min, max)    { return Math.floor(Math.random() * (max - min)) + min; }
  _sleep(ms)         { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = PothliProcessor;
