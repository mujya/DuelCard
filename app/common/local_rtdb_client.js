/* eslint-disable no-param-reassign, no-underscore-dangle, prefer-object-spread */
const { io } = require('socket.io-client');
const generatePushId = require('./generate_push_id');
const tree = require('./local_rtdb_tree');

function resolveApiOrigin() {
  if (typeof window !== 'undefined' && window.location && window.location.origin && /^https?:/i.test(window.location.origin)) {
    return window.location.origin;
  }
  if (process.env.API_URL && /^https?:/i.test(process.env.API_URL)) {
    return process.env.API_URL.replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
}

let socket = null;
let currentToken = null;
let currentUid = null;
let isAuthed = false;
let isConnected = false;
let nextSubSeq = 1;

// Active subscriptions keyed by subId
const activeSubs = new Map();
// Listeners on .info/connected
const connectionListeners = new Set();
// Queued auth promises while connecting
let authWaiters = [];

function notifyConnectionListeners(connected) {
  connectionListeners.forEach((entry) => {
    try {
      const snap = tree.createSnapshot('.info/connected', connected, (p) => new LocalClientRef(p, {}));
      entry.cb.call(entry.ctx, snap);
    } catch (e) {
      // Ignore listener errors
    }
  });
}

function sendSubscribe(sub) {
  if (!socket || !socket.connected) return;
  socket.emit('rtdb:subscribe', { subId: sub.subId, path: sub.path, query: sub.query }, (res) => {
    if (res && !res.ok && typeof sub.cancelCb === 'function') {
      sub.cancelCb(new Error(res.error || 'Subscribe failed'));
    }
  });
}

function resubscribeAll() {
  activeSubs.forEach((sub) => {
    sendSubscribe(sub);
  });
}

function performAuth(token) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      authWaiters.push({ token, resolve, reject });
      return;
    }
    socket.emit('rtdb:auth', token, (res) => {
      if (res && res.ok) {
        currentUid = res.uid || null;
        isAuthed = !!currentUid;
        resubscribeAll();
        resolve({ user: currentUid ? { uid: currentUid } : null });
      } else {
        isAuthed = false;
        reject(new Error((res && res.error) || 'LocalRTDB authentication failed'));
      }
    });
  });
}

function dispatchSnapshot(sub, nextVal) {
  const {
    eventType,
    cb,
    ctx,
    path,
  } = sub;
  const makeSnap = (p, v) => tree.createSnapshot(p, v, (rp) => new LocalClientRef(rp, {}));

  if (eventType === 'value') {
    if (!sub.initialized || JSON.stringify(sub.lastVal) !== JSON.stringify(nextVal)) {
      sub.initialized = true;
      sub.lastVal = tree.deepClone(nextVal);
      cb.call(ctx, makeSnap(path, nextVal));
    }
    return;
  }

  const prevObj = tree.isPlainObject(sub.lastVal) ? sub.lastVal : {};
  const nextObj = tree.isPlainObject(nextVal) ? nextVal : {};
  const prevKeys = Object.keys(prevObj);
  const nextKeys = Object.keys(nextObj);

  if (eventType === 'child_added') {
    let prevKey = null;
    for (let i = 0; i < nextKeys.length; i += 1) {
      const k = nextKeys[i];
      if (!sub.initialized || !(k in prevObj)) {
        cb.call(ctx, makeSnap(tree.joinPath(path, k), nextObj[k]), prevKey);
      }
      prevKey = k;
    }
  } else if (eventType === 'child_changed' && sub.initialized) {
    let prevKey = null;
    for (let i = 0; i < nextKeys.length; i += 1) {
      const k = nextKeys[i];
      if (k in prevObj && JSON.stringify(prevObj[k]) !== JSON.stringify(nextObj[k])) {
        cb.call(ctx, makeSnap(tree.joinPath(path, k), nextObj[k]), prevKey);
      }
      prevKey = k;
    }
  } else if (eventType === 'child_removed' && sub.initialized) {
    for (let i = 0; i < prevKeys.length; i += 1) {
      const k = prevKeys[i];
      if (!(k in nextObj)) {
        cb.call(ctx, makeSnap(tree.joinPath(path, k), prevObj[k]));
      }
    }
  }

  sub.initialized = true;
  sub.lastVal = tree.deepClone(nextVal);
}

function ensureSocket() {
  if (socket) {
    return socket;
  }
  const origin = resolveApiOrigin();
  socket = io(`${origin}/rtdb`, {
    path: '/rtdb-socket',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => {
    isConnected = true;
    const pending = authWaiters.slice();
    authWaiters = [];

    const finishConnect = () => {
      resubscribeAll();
      notifyConnectionListeners(true);
    };

    if (pending.length > 0) {
      const latest = pending[pending.length - 1];
      currentToken = latest.token;
      performAuth(currentToken)
        .then((res) => {
          pending.forEach((w) => w.resolve(res));
          notifyConnectionListeners(true);
        })
        .catch((err) => {
          pending.forEach((w) => w.reject(err));
          notifyConnectionListeners(true);
        });
    } else if (currentToken) {
      performAuth(currentToken).then(() => notifyConnectionListeners(true)).catch(finishConnect);
    } else {
      finishConnect();
    }
  });

  socket.on('disconnect', () => {
    isConnected = false;
    isAuthed = false;
    notifyConnectionListeners(false);
  });

  socket.on('rtdb:snapshot', (msg) => {
    if (!msg || !msg.subId) return;
    const sub = activeSubs.get(msg.subId);
    if (!sub) return;
    try {
      dispatchSnapshot(sub, msg.val);
    } catch (e) {
      // Prevent one broken listener from stopping other updates
    }
  });

  return socket;
}

function waitForConnectedSocket() {
  const s = ensureSocket();
  if (s.connected) {
    return Promise.resolve(s);
  }
  return new Promise((resolve) => {
    s.once('connect', () => resolve(s));
  });
}

class LocalClientRef {
  constructor(path, query) {
    this._path = tree.normalizePath(path || '');
    this._query = query || {};
    this.key = tree.getKeyFromPath(this._path);
    this.ref = this;
  }

  name() {
    return this.key;
  }

  toString() {
    return `local://rtdb/${this._path}`;
  }

  get parent() {
    const p = tree.getParentPath(this._path);
    return p === null ? null : new LocalClientRef(p, {});
  }

  // eslint-disable-next-line class-methods-use-this
  get root() {
    return new LocalClientRef('', {});
  }

  child(subPath) {
    return new LocalClientRef(tree.joinPath(this._path, subPath), {});
  }

  orderByChild(key) {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { orderBy: 'child', orderByChild: key }));
  }

  orderByKey() {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { orderBy: 'key' }));
  }

  orderByValue() {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { orderBy: 'value' }));
  }

  orderByPriority() {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { orderBy: 'priority' }));
  }

  startAt(val) {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { startAt: val }));
  }

  endAt(val) {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { endAt: val }));
  }

  equalTo(val) {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { equalTo: val }));
  }

  limitToFirst(n) {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { limitToFirst: n }));
  }

  limitToLast(n) {
    return new LocalClientRef(this._path, Object.assign({}, this._query, { limitToLast: n }));
  }

  _write(op, value, cb) {
    const p = waitForConnectedSocket().then((s) => new Promise((resolve, reject) => {
      s.emit('rtdb:write', { path: this._path, op, value }, (res) => {
        if (res && res.ok) {
          resolve();
        } else {
          reject(new Error((res && res.error) || `LocalRTDB ${op} failed`));
        }
      });
    }));
    if (typeof cb === 'function') {
      p.then(() => cb(null), (err) => cb(err));
    }
    return p;
  }

  set(value, cb) {
    return this._write('set', value, cb);
  }

  setWithPriority(value, priority, cb) {
    const payload = tree.isPlainObject(value) ? Object.assign({}, value, { '.priority': priority }) : value;
    return this._write('set', payload, cb);
  }

  update(updates, cb) {
    return this._write('update', updates, cb);
  }

  remove(cb) {
    return this._write('remove', null, cb);
  }

  push(value, cb) {
    const id = generatePushId();
    const childRef = this.child(id);
    if (value !== undefined) {
      childRef.set(value, cb);
    }
    return childRef;
  }

  once(eventType, cb, cancelCb) {
    if (this._path === '.info/connected') {
      ensureSocket();
      const snap = tree.createSnapshot('.info/connected', isConnected, (p) => new LocalClientRef(p, {}));
      if (typeof cb === 'function') {
        setTimeout(() => cb(snap), 0);
      }
      return Promise.resolve(snap);
    }

    const p = waitForConnectedSocket().then((s) => new Promise((resolve, reject) => {
      s.emit('rtdb:once', { path: this._path, query: this._query }, (res) => {
        if (res && res.ok) {
          const snap = tree.createSnapshot(this._path, res.val, (rp) => new LocalClientRef(rp, {}));
          resolve(snap);
        } else {
          reject(new Error((res && res.error) || 'LocalRTDB once failed'));
        }
      });
    }));

    if (typeof cb === 'function') {
      p.then((snap) => cb(snap), (err) => {
        if (typeof cancelCb === 'function') cancelCb(err);
      });
    }
    return p;
  }

  on(eventType, cb, cancelCb, ctx) {
    const context = typeof cancelCb === 'function' ? ctx : cancelCb;
    const cancel = typeof cancelCb === 'function' ? cancelCb : null;

    if (this._path === '.info/connected') {
      ensureSocket();
      const entry = { cb, ctx: context };
      connectionListeners.add(entry);
      const snap = tree.createSnapshot('.info/connected', isConnected, (p) => new LocalClientRef(p, {}));
      setTimeout(() => {
        if (connectionListeners.has(entry)) {
          cb.call(context, snap);
        }
      }, 0);
      return cb;
    }

    const subId = `sub_${nextSubSeq}`;
    nextSubSeq += 1;
    const sub = {
      subId,
      path: this._path,
      query: this._query,
      eventType,
      cb,
      cancelCb: cancel,
      ctx: context,
      initialized: false,
      lastVal: undefined,
    };
    activeSubs.set(subId, sub);
    ensureSocket();
    if (socket.connected && (!currentToken || isAuthed)) {
      sendSubscribe(sub);
    }
    return cb;
  }

  off(eventType, cb) {
    if (this._path === '.info/connected') {
      connectionListeners.forEach((entry) => {
        if (!cb || entry.cb === cb) {
          connectionListeners.delete(entry);
        }
      });
      return;
    }

    const toDelete = [];
    activeSubs.forEach((sub, subId) => {
      const samePath = sub.path === this._path;
      const sameType = !eventType || sub.eventType === eventType;
      const sameCb = !cb || sub.cb === cb;
      if (samePath && sameType && sameCb) {
        toDelete.push(subId);
      }
    });
    for (let i = 0; i < toDelete.length; i += 1) {
      const subId = toDelete[i];
      activeSubs.delete(subId);
      if (socket && socket.connected) {
        socket.emit('rtdb:unsubscribe', { subId });
      }
    }
  }

  onDisconnect() {
    const targetPath = this._path;
    const sendOp = (op, value, cb) => {
      const p = waitForConnectedSocket().then((s) => new Promise((resolve, reject) => {
        s.emit('rtdb:onDisconnect', { path: targetPath, op, value }, (res) => {
          if (res && res.ok) resolve();
          else reject(new Error((res && res.error) || 'onDisconnect failed'));
        });
      }));
      if (typeof cb === 'function') {
        p.then(() => cb(null), (err) => cb(err));
      }
      return p;
    };
    return {
      set: (val, cb) => sendOp('set', val, cb),
      update: (val, cb) => sendOp('update', val, cb),
      remove: (cb) => sendOp('remove', null, cb),
      cancel: (cb) => sendOp('cancel', null, cb),
    };
  }
}

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return 'local://rtdb/';
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return 'local://rtdb/';
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function LocalFirebase(urlOrPath) {
  ensureSocket();
  if (!urlOrPath) {
    return new LocalClientRef('', {});
  }
  return new LocalClientRef(tree.normalizePath(urlOrPath), {});
}

LocalFirebase.ServerValue = {
  TIMESTAMP: tree.SERVER_VALUE_TIMESTAMP,
};

LocalFirebase.normalizeDatabaseUrl = normalizeDatabaseUrl;
LocalFirebase.ensureInitialized = function ensureInitialized() {
  ensureSocket();
  return { name: '[LOCAL_RTDB]' };
};

LocalFirebase.auth = function auth() {
  return {
    signInWithCustomToken(token) {
      currentToken = token;
      ensureSocket();
      return performAuth(token);
    },
    signOut() {
      currentToken = null;
      currentUid = null;
      isAuthed = false;
      if (socket && socket.connected) {
        socket.emit('rtdb:auth', null);
      }
      return Promise.resolve();
    },
  };
};

LocalFirebase.database = function database() {
  ensureSocket();
  return {
    ref: (p) => new LocalClientRef(p || '', {}),
    refFromURL: (u) => new LocalClientRef(tree.normalizePath(u || ''), {}),
  };
};

LocalFirebase.app = function app() {
  return LocalFirebase.ensureInitialized();
};

module.exports = LocalFirebase;
