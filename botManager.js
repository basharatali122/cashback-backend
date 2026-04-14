const path            = require('path');
const fs              = require('fs');
const Database        = require('./database/database');
const PothliProcessor = require('./pothli-processor');
const CashbackProcessor = require('./cashback-processor');

class BotManager {
  constructor(io) {
    this.io        = io;
    this.instances = new Map();
  }

  _key(userId, profileName) {
    return `${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  _room(userId, profileName) {
    return `profile:${userId}:${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  _dataDir(userId, profileName) {
    const base = process.env.DATA_DIR || './data';
    const dir  = path.join(base, userId, profileName.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _createProcessor(claimMode, db) {
    const Cls  = claimMode === 'cashback' ? CashbackProcessor : PothliProcessor;
    const proc = new Cls(db);

    // Wrap db so processors always get Promises regardless of DB impl
    proc.db = {
      getAllAccounts:   ()            => Promise.resolve(db.getAllAccounts()),
      updateAccount:   (acc)         => Promise.resolve(db.updateAccount(acc)),
      addProcessingLog:(id, s, m, d) => Promise.resolve(db.addProcessingLog(id, s, m, d)),
    };

    return proc;
  }

  async getOrCreateInstance(userId, profileName, claimMode = 'pothli') {
    const key = this._key(userId, profileName);

    if (this.instances.has(key)) {
      const existing = this.instances.get(key);
      // If mode changed and not running → recreate
      if (existing.claimMode !== claimMode && !existing.processor.isProcessing) {
        await this.destroyInstance(userId, profileName);
      } else {
        return existing;
      }
    }

    const dbPath  = path.join(this._dataDir(userId, profileName), 'accounts.db');
    const db      = new Database(dbPath);
    await db.init();

    const processor = this._createProcessor(claimMode, db);
    processor.instanceId = `${userId.substring(0, 8)}_${profileName}`;

    const room = this._room(userId, profileName);
    const emit = (event, data) =>
      this.io.to(room).emit(event, { ...data, _profile: profileName });

    const eventMap = {
      terminal:    'bot:terminal',
      status:      'bot:status',
      progress:    'bot:progress',
      completed:   'bot:completed',
      cycleStart:  'bot:cycleStart',
      cycleUpdate: 'bot:cycleUpdate',
    };

    const boundHandlers = {};
    for (const [ev, socketEv] of Object.entries(eventMap)) {
      boundHandlers[ev] = (data) => emit(socketEv, data);
      processor.on(ev, boundHandlers[ev]);
    }

    const instance = { processor, db, boundHandlers, room, claimMode, createdAt: Date.now() };
    this.instances.set(key, instance);
    console.log(`🤖 [${key}] created | mode:${claimMode} | db:${dbPath}`);
    return instance;
  }

  async getInstance(userId, profileName) {
    return this.instances.get(this._key(userId, profileName)) || null;
  }

  async destroyInstance(userId, profileName) {
    const key      = this._key(userId, profileName);
    const instance = this.instances.get(key);
    if (!instance) return;

    try { if (instance.processor.isProcessing) await instance.processor.stopProcessing(); } catch (_) {}
    for (const [ev, handler] of Object.entries(instance.boundHandlers)) {
      try { instance.processor.off(ev, handler); } catch (_) {}
    }
    instance.processor.removeAllListeners();
    try { instance.db.close(); } catch (_) {}
    this.instances.delete(key);
    console.log(`🗑️  [${key}] destroyed`);
  }

  getActiveProcessors(userId) {
    const result = [];
    for (const [key, inst] of this.instances.entries()) {
      if (!key.startsWith(`${userId}:`)) continue;
      const profileName = key.substring(userId.length + 1);
      result.push({
        profileName,
        isRunning:    inst.processor.isProcessing,
        claimMode:    inst.claimMode,
        currentCycle: inst.processor.currentCycle || 0,
        totalCycles:  inst.processor.totalCycles  || 0,
        accountCount: inst.db.getAccountCount ? inst.db.getAccountCount() : 0,
      });
    }
    return result;
  }

  getServerStats() {
    let totalInstances = 0, totalRunning = 0;
    for (const inst of this.instances.values()) {
      totalInstances++;
      if (inst.processor.isProcessing) totalRunning++;
    }
    return { totalInstances, totalRunning };
  }

  async shutdownAll() {
    const keys = [...this.instances.keys()];
    await Promise.allSettled(keys.map(key => {
      const [userId, ...rest] = key.split(':');
      return this.destroyInstance(userId, rest.join(':'));
    }));
  }
}

module.exports = BotManager;
