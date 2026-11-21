const firebase = require('firebase/app').default || require('firebase/app');
require('firebase/auth');
require('firebase/database');

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function normalizeFirebasePathUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return rawUrl;
  }
  const baseUrl = normalizeDatabaseUrl(process.env.FIREBASE_URL);
  let target = rawUrl.trim();

  // Fix accidental concatenation when FIREBASE_URL lacked a trailing slash
  // e.g. "https://db.asia-southeast1.firebasedatabase.appuser-inventory/..."
  if (baseUrl) {
    const baseNoSlash = baseUrl.slice(0, -1);
    if (target.startsWith(baseNoSlash) && target.length > baseNoSlash.length && target[baseNoSlash.length] !== '/') {
      target = `${baseUrl}${target.slice(baseNoSlash.length)}`;
    }
  }

  // Collapse duplicate slashes in path (preserving protocol "https://")
  return target.replace(/^(https?:\/\/)|(\/)+/g, (match, protocol) => protocol || '/');
}

function getFirebaseConfig() {
  const databaseURL = normalizeDatabaseUrl(process.env.FIREBASE_URL);
  const projectId = process.env.FIREBASE_PROJECT_ID || undefined;
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN
    || (projectId ? `${projectId}.firebaseapp.com` : undefined);

  return {
    apiKey: process.env.FIREBASE_API_KEY || undefined,
    authDomain,
    databaseURL: databaseURL || undefined,
    projectId,
  };
}

function ensureInitialized() {
  if (!firebase.apps.length) {
    const cfg = getFirebaseConfig();
    if (!cfg.databaseURL) {
      throw new Error('FIREBASE_URL must be set');
    }
    firebase.initializeApp(cfg);
  }
  return firebase.app();
}

function Firebase(urlOrPath) {
  ensureInitialized();
  const db = firebase.database();
  if (!urlOrPath) {
    return db.ref();
  }
  if (typeof urlOrPath === 'string' && /^https?:\/\//i.test(urlOrPath)) {
    return db.refFromURL(normalizeFirebasePathUrl(urlOrPath));
  }
  return db.ref(urlOrPath);
}

Firebase.ServerValue = firebase.database.ServerValue;
Firebase.ensureInitialized = ensureInitialized;
Firebase.normalizeDatabaseUrl = normalizeDatabaseUrl;
Firebase.auth = function () {
  ensureInitialized();
  return firebase.auth();
};
Firebase.database = function () {
  ensureInitialized();
  return firebase.database();
};
Firebase.app = function () {
  return ensureInitialized();
};

module.exports = Firebase;
