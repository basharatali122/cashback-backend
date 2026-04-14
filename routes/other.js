const { normalizeProxy, parseProxyList, testProxy } = require('../proxyUtils');

const proxyRouter = require('express').Router();

proxyRouter.get('/:profile', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    res.json({ config: db.getProxyConfig() || { enabled: false, proxyList: [] } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

proxyRouter.post('/:profile', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    let list = req.body.proxyList || [];
    if (typeof list === 'string') list = list.split('\n');
    const normalized = parseProxyList(list.join('\n'));
    db.saveProxyConfig({ enabled: !!req.body.enabled, proxyList: normalized });
    res.json({ success: true, saved: normalized.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

proxyRouter.post('/:profile/normalize', (req, res) => {
  try {
    const raw   = req.body.proxyList || '';
    const lines = typeof raw === 'string' ? raw : raw.join('\n');
    const normalized = parseProxyList(lines);
    res.json({ success: true, normalized, count: normalized.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

proxyRouter.post('/:profile/test', async (req, res) => {
  try {
    const { proxyUrl } = req.body;
    if (!proxyUrl) return res.status(400).json({ error: 'No proxy URL' });
    const normalized = normalizeProxy(proxyUrl);
    if (!normalized) return res.json({ success: false, message: `Cannot parse: ${proxyUrl}` });
    const result = await testProxy(normalized);
    res.json(result);
  } catch (err) { res.json({ success: false, message: err.message }); }
});

module.exports.proxyRouter = proxyRouter;

const statsRouter = require('express').Router();
statsRouter.get('/:profile', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    res.json({ totals: db.getStatsTotals() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
module.exports.statsRouter = statsRouter;
