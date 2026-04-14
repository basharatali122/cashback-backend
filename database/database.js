/**
 * database.js — SQLite wrapper using sql.js (pure JavaScript)
 *
 * WHY sql.js instead of better-sqlite3:
 *   better-sqlite3 requires Microsoft Visual Studio C++ Build Tools to
 *   compile native bindings on Windows. sql.js is compiled to WebAssembly
 *   and runs in pure JS — zero native compilation, works on any OS.
 *
 * API surface: identical to the original better-sqlite3 wrapper.
 */

const path = require('path');
const fs   = require('fs');

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db     = null;
    this._SQL   = null;
  }

  async init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const initSqlJs = require('sql.js');
    this._SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new this._SQL.Database(fileBuffer);
    } else {
      this.db = new this._SQL.Database();
    }

    this._createTables();
    this._save();
    console.log('✅ Database ready:', this.dbPath);
    return this;
  }

  _save() {
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      console.error('DB save error:', err.message);
    }
  }

  _createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        score INTEGER DEFAULT 0,
        userid TEXT,
        dynamicpass TEXT,
        last_processed DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);

      CREATE TABLE IF NOT EXISTS processing_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT,
        message TEXT,
        details TEXT
      );

      CREATE TABLE IF NOT EXISTS proxy_config (
        id INTEGER PRIMARY KEY,
        config TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        accounts_processed INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        regular_spins INTEGER DEFAULT 0,
        weekend_spins INTEGER DEFAULT 0,
        total_score_won INTEGER DEFAULT 0,
        session_id TEXT
      );
    `);
  }

  _all(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } catch (err) {
      console.error('DB _all error:', err.message);
      return [];
    }
  }

  _get(sql, params = []) {
    const rows = this._all(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  _run(sql, params = []) {
    try {
      this.db.run(sql, params);
      const changes = this.db.getRowsModified();
      const lastRow = this._get('SELECT last_insert_rowid() as id');
      this._save();
      return { changes, lastInsertRowid: lastRow?.id || 0 };
    } catch (err) {
      console.error('DB _run error:', err.message);
      return { changes: 0, lastInsertRowid: 0 };
    }
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  getAllAccounts() {
    return this._all('SELECT * FROM accounts ORDER BY created_at DESC');
  }

  addAccount(username, password, score = 0) {
    return this._run(
      'INSERT OR IGNORE INTO accounts (username, password, score) VALUES (?, ?, ?)',
      [username, password, score]
    );
  }

  bulkAdd(accounts) {
    let added = 0, duplicates = 0;
    for (const { username, password, score = 0 } of accounts) {
      try {
        this.db.run(
          'INSERT OR IGNORE INTO accounts (username, password, score) VALUES (?, ?, ?)',
          [username, password, score]
        );
        if (this.db.getRowsModified() > 0) added++; else duplicates++;
      } catch (_) { duplicates++; }
    }
    this._save();
    return { added, duplicates };
  }

  generateAccounts(username, startRange, endRange, password) {
    const pad  = String(endRange).length;
    const rows = [];
    for (let i = startRange; i <= endRange; i++) {
      rows.push({ username: `${username}${String(i).padStart(pad, '0')}`, password, score: 0 });
    }
    return this.bulkAdd(rows);
  }

  updateAccount(account) {
    return this._run(
      `UPDATE accounts
         SET username=?, password=?, score=?, userid=?, dynamicpass=?,
             last_processed=datetime('now'), updated_at=datetime('now')
       WHERE id=?`,
      [account.username, account.password, account.score || 0,
       account.userid || null, account.dynamicpass || null, account.id]
    );
  }

  deleteAccount(id) {
    return this._run('DELETE FROM accounts WHERE id=?', [id]);
  }

  bulkDelete(ids) {
    for (const id of ids) {
      try { this.db.run('DELETE FROM accounts WHERE id=?', [id]); } catch (_) {}
    }
    this._save();
    return { deleted: ids.length };
  }

  clearAll()        { return this._run('DELETE FROM accounts'); }
  getAccountCount() { return this._get('SELECT COUNT(*) as count FROM accounts')?.count || 0; }

  // ── Processing Logs ───────────────────────────────────────────────────────

  addProcessingLog(accountId, status, message, details = null) {
    try {
      this.db.run(
        'INSERT INTO processing_logs (account_id, status, message, details) VALUES (?, ?, ?, ?)',
        [accountId, status, message, details ? JSON.stringify(details) : null]
      );
      this._save();
    } catch (_) {}
  }

  // ── Proxy ─────────────────────────────────────────────────────────────────

  getProxyConfig() {
    try {
      const row = this._get('SELECT config FROM proxy_config WHERE id=1');
      return row ? JSON.parse(row.config) : null;
    } catch { return null; }
  }

  saveProxyConfig(config) {
    this._run('INSERT OR REPLACE INTO proxy_config (id, config) VALUES (1, ?)', [JSON.stringify(config)]);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  saveSessionStats(data) {
    this._run(
      `INSERT INTO stats (accounts_processed, wins, regular_spins, weekend_spins, total_score_won, session_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.accountsProcessed || 0, data.wins || 0, data.regularSpins || 0,
       data.weekendSpins || 0, data.totalScoreWon || 0, data.sessionId || null]
    );
  }

  getStatsTotals() {
    return this._get(`
      SELECT
        SUM(accounts_processed) AS totalProcessed,
        SUM(wins)               AS totalWins,
        SUM(regular_spins)      AS totalRegularSpins,
        SUM(weekend_spins)      AS totalWeekendSpins,
        SUM(total_score_won)    AS totalScoreWon,
        COUNT(*)                AS totalSessions
      FROM stats
    `) || {};
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  close() {
    try { this._save(); this.db?.close(); } catch (_) {}
  }
}

module.exports = Database;
