const admin = require('firebase-admin');

let _initialized = false;

function ensureAdmin() {
  if (_initialized) return;

  // Support both formats:
  // 1. FIREBASE_SERVICE_ACCOUNT = single JSON string (preferred)
  // 2. Individual FIREBASE_PROJECT_ID + FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL vars

  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Format 1: single JSON blob
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(sa);
    } catch (e) {
      console.error('❌ FIREBASE_SERVICE_ACCOUNT JSON parse failed:', e.message);
      _initialized = true;
      return;
    }
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    // Format 2: individual env vars (what this project actually uses)
    credential = admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    });
  } else {
    console.warn('⚠️  No Firebase credentials found — running in dev mode (tokens not verified)');
    _initialized = true;
    return;
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential });
    console.log(`✅ Firebase Admin initialized (project: ${process.env.FIREBASE_PROJECT_ID})`);
  }
  _initialized = true;
}

async function verifyFirebaseToken(token) {
  ensureAdmin();

  // Dev mode — no credentials configured
  if (!admin.apps.length) {
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('Invalid token');
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      return { uid: payload.user_id || payload.sub || 'dev-user', email: payload.email || 'dev@localhost' };
    } catch {
      return { uid: 'dev-user', email: 'dev@localhost' };
    }
  }

  return admin.auth().verifyIdToken(token);
}

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing auth token' });
    }
    const token   = authHeader.slice(7);
    const decoded = await verifyFirebaseToken(token);
    req.userId    = decoded.uid;
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { verifyToken, verifyFirebaseToken };
