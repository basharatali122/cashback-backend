// const router = require('express').Router();

// // GET /api/accounts/:profile
// router.get('/:profile', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     res.json({ accounts: db.getAllAccounts() });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/accounts/:profile/bulk
// router.post('/:profile/bulk', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const result = db.bulkAdd(req.body.accounts || []);
//     res.json({ success: true, ...result });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // POST /api/accounts/:profile/generate
// router.post('/:profile/generate', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const { username, startRange, endRange, password } = req.body;
//     const count = endRange - startRange + 1;
//     if (count > 5000) return res.status(400).json({ error: 'Max 5000 accounts per generation' });
//     const result = db.generateAccounts(username, startRange, endRange, password || 'password123');
//     res.json({ success: true, generated: count, ...result });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // DELETE /api/accounts/:profile/bulk/delete
// router.delete('/:profile/bulk/delete', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     const result = db.bulkDelete(req.body.ids || []);
//     res.json({ success: true, ...result });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // DELETE /api/accounts/:profile/all/clear
// router.delete('/:profile/all/clear', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     db.clearAll();
//     res.json({ success: true });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// // DELETE /api/accounts/:profile/:id
// router.delete('/:profile/:id', async (req, res) => {
//   try {
//     const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
//     db.deleteAccount(parseInt(req.params.id));
//     res.json({ success: true });
//   } catch (err) { res.status(500).json({ error: err.message }); }
// });

// module.exports = router;



const router = require('express').Router();
const crypto = require('crypto');

// ── MD5 helper (game server expects MD5-hashed passwords) ──────────────────
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function hashPassword(pw) {
  if (!pw) return md5('');
  // If already a 32-char hex string, it's already MD5 — don't double-hash
  return /^[a-f0-9]{32}$/.test(pw) ? pw : md5(pw);
}

// GET /api/accounts/:profile
router.get('/:profile', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    res.json({ accounts: db.getAllAccounts() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/:profile/bulk
router.post('/:profile/bulk', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const raw = req.body.accounts || [];
    const hashed = raw
      .filter(a => a.username)
      .map(a => ({
        username: (a.username || '').trim(),
        password: hashPassword(a.password),
        score: a.score || 0,
      }));
    const result = db.bulkAdd(hashed);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/:profile/generate
router.post('/:profile/generate', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const { username, startRange, endRange, password } = req.body;
    const count = endRange - startRange + 1;
    if (count > 5000) return res.status(400).json({ error: 'Max 5000 accounts per generation' });
    // Hash password once before passing to generateAccounts
    const hashedPw = hashPassword(password || 'password123');
    const result = db.generateAccounts(username, startRange, endRange, hashedPw);
    res.json({ success: true, generated: count, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounts/:profile/bulk/delete
router.delete('/:profile/bulk/delete', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    const result = db.bulkDelete(req.body.ids || []);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounts/:profile/all/clear
router.delete('/:profile/all/clear', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    db.clearAll();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounts/:profile/:id
router.delete('/:profile/:id', async (req, res) => {
  try {
    const { db } = await req.app.get('botManager').getOrCreateInstance(req.userId, req.params.profile);
    db.deleteAccount(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;