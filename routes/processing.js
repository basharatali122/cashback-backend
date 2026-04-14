const router = require('express').Router();

// GET /api/processing/all/status — MUST be before /:profile routes
router.get('/all/status', (req, res) => {
  try {
    const profiles = req.app.get('botManager').getActiveProcessors(req.userId);
    res.json({ success: true, profiles });
  } catch (err) {
    console.error('all/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/processing/:profile/status
router.get('/:profile/status', async (req, res) => {
  try {
    const instance = await req.app.get('botManager').getInstance(req.userId, req.params.profile);
    if (!instance) return res.json({ running: false });

    const proc = instance.processor;
    res.json({
      running:       proc.isProcessing,
      claimMode:     instance.claimMode,
      currentCycle:  proc.currentCycle  || 0,
      totalCycles:   proc.totalCycles   || 0,
      activeWorkers: proc.stats?.activeWorkers || 0,
      stats:         proc.stats || {},
    });
  } catch (err) {
    console.error('status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processing/:profile/start
router.post('/:profile/start', async (req, res) => {
  try {
    const botManager = req.app.get('botManager');
    const { repetitions = 1, accountIds, claimMode = 'pothli', gameConfig } = req.body;

    const { processor, db } = await botManager.getOrCreateInstance(
      req.userId, req.params.profile, claimMode
    );

    if (processor.isProcessing) {
      return res.status(400).json({ error: 'Already processing' });
    }

    // Apply game config overrides
    if (gameConfig && typeof gameConfig === 'object') {
      for (const k of ['LOGIN_WS_URL', 'GAME_VERSION', 'ORIGIN']) {
        if (gameConfig[k] && typeof gameConfig[k] === 'string') {
          processor.config[k] = gameConfig[k];
        }
      }
    }

    console.log(`🎮 [${req.userId.substring(0, 8)}] ${claimMode} → ${processor.config.LOGIN_WS_URL} | Origin: ${processor.config.ORIGIN}`);

    // Proxy config
    const proxyConfig = db.getProxyConfig();
    let useProxy = false, proxyList = [];
    if (proxyConfig?.enabled) {
      useProxy  = true;
      proxyList = Array.isArray(proxyConfig.proxyList)
        ? proxyConfig.proxyList
        : (proxyConfig.proxyList || '').split('\n').filter(Boolean);
    }

    // Account IDs — use all if none specified
    let ids = Array.isArray(accountIds) && accountIds.length > 0
      ? accountIds
      : db.getAllAccounts().map(a => a.id);

    if (ids.length === 0) {
      return res.status(400).json({ error: 'No accounts found. Please add accounts first.' });
    }

    const result = await processor.startProcessing(ids, repetitions, useProxy, proxyList);
    res.json({ success: true, claimMode, ...result });

  } catch (err) {
    console.error('Start processing error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processing/:profile/stop
router.post('/:profile/stop', async (req, res) => {
  try {
    const instance = await req.app.get('botManager').getInstance(req.userId, req.params.profile);
    if (!instance) return res.json({ success: true, message: 'Not running' });
    const result = await instance.processor.stopProcessing();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Stop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
