/* eslint-disable no-param-reassign */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../../../config/config');
const Logger = require('../../../app/common/logger.coffee');
const tree = require('../../../app/common/local_rtdb_tree');
const { getStore } = require('./store');

function canRead(uid, path) {
  const segs = tree.splitPath(path);
  if (segs.length === 0) return false;
  const root = segs[0];

  if (
    root === 'system-status'
    || root === 'news'
    || root === 'daily-challenges'
    || root === 'crafting'
    || root === 'streamer-whitelist'
    || root === 'user-ribbons'
    || root === 'user-purchase-counts'
  ) {
    return true;
  }
  if (!uid) return false;

  if (
    root === 'boss-events'
    || root === 'shop-sales'
    || root === 'username-index'
    || root === 'users'
    || root === 'user-ranking'
    || root === 'user-ladder-position'
    || root === 'games-data'
    || root === 'matchmaking'
  ) {
    return true;
  }

  if (root === 'chat') {
    if (segs[1] === 'conversations' && segs[2]) {
      return segs[2].includes(uid);
    }
    if (segs[1] === 'users' && segs[2]) {
      return segs[2] === uid;
    }
    return false;
  }

  if (root.startsWith('user-')) {
    return segs[1] === uid;
  }

  return false;
}

function canWrite(uid, path) {
  const segs = tree.splitPath(path);
  if (segs.length === 0) return false;
  const root = segs[0];

  if (root === 'telemetry') {
    return true;
  }
  if (!uid) return false;

  if (root === 'users') {
    if (segs[1] === uid) return true;
    // Allow writing self into another user's buddy list
    if ((segs[2] === 'buddy-list' || segs[2] === 'buddies') && segs[3] === uid) {
      return true;
    }
    return false;
  }

  if (root === 'chat') {
    if (segs[1] === 'conversations' && segs[2]) {
      return segs[2].includes(uid);
    }
    if (segs[1] === 'users') {
      if (segs[2] === uid) return true;
      if (segs[3] === 'buddy-invites' && segs[4] === uid) return true;
    }
    return false;
  }

  if (root === 'matchmaking') {
    return true;
  }

  if (
    root === 'user-decks'
    || root === 'user-games'
    || root === 'user-news'
    || root === 'user-new-player-progression'
    || root === 'user-inventory'
    || root === 'user-quests'
    || root === 'user-ranking'
    || root === 'user-achievements'
    || root === 'user-progression'
    || root === 'user-challenge-progression'
    || root === 'user-twitch-rewards'
    || root === 'user-gauntlet-run'
  ) {
    return segs[1] === uid;
  }

  return false;
}

function attachLocalRtdbServer(httpServer) {
  const store = getStore();
  const io = new Server(httpServer, {
    path: '/rtdb-socket',
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  const nsp = io.of('/rtdb');

  nsp.on('connection', (socket) => {
    socket.uid = null;
    const subscriptions = new Map();
    const disconnectOps = new Map();

    const onStoreChange = (evt) => {
      subscriptions.forEach((sub, subId) => {
        if (tree.pathsOverlap(sub.path, evt.path)) {
          store.get(sub.path).then((raw) => {
            const filtered = tree.applyQuery(raw, sub.query);
            socket.emit('rtdb:snapshot', { subId, path: sub.path, val: filtered });
          }).catch(() => {});
        }
      });
    };

    store.on('change', onStoreChange);

    socket.on('rtdb:auth', (token, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      if (!token) {
        socket.uid = null;
        return done({ ok: true, uid: null });
      }
      try {
        const secret = config.get('jwt.secretKey');
        const decoded = jwt.verify(token, secret);
        const uid = decoded.uid || (decoded.d && decoded.d.id) || decoded.id || null;
        if (!uid) {
          return done({ ok: false, error: 'Invalid token payload: missing uid' });
        }
        socket.uid = uid;
        return done({ ok: true, uid });
      } catch (err) {
        return done({ ok: false, error: err.message });
      }
    });

    socket.on('rtdb:once', async (req, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      try {
        const path = tree.normalizePath(req && req.path);
        if (!canRead(socket.uid, path)) {
          return done({ ok: false, error: `Permission denied reading ${path}` });
        }
        const raw = await store.get(path);
        const filtered = tree.applyQuery(raw, req && req.query);
        return done({ ok: true, val: filtered });
      } catch (err) {
        return done({ ok: false, error: err.message });
      }
    });

    socket.on('rtdb:subscribe', async (req, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      try {
        const subId = req && req.subId;
        const path = tree.normalizePath(req && req.path);
        const query = (req && req.query) || {};
        if (!subId) {
          return done({ ok: false, error: 'Missing subId' });
        }
        if (!canRead(socket.uid, path)) {
          return done({ ok: false, error: `Permission denied subscribing to ${path}` });
        }
        subscriptions.set(subId, { path, query });
        const raw = await store.get(path);
        const filtered = tree.applyQuery(raw, query);
        socket.emit('rtdb:snapshot', { subId, path, val: filtered });
        return done({ ok: true });
      } catch (err) {
        return done({ ok: false, error: err.message });
      }
    });

    socket.on('rtdb:unsubscribe', (req) => {
      if (req && req.subId) {
        subscriptions.delete(req.subId);
      }
    });

    socket.on('rtdb:write', async (req, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      try {
        const path = tree.normalizePath(req && req.path);
        const op = req && req.op;
        if (!canWrite(socket.uid, path)) {
          return done({ ok: false, error: `Permission denied writing ${path}` });
        }
        if (op === 'set') {
          await store.set(path, req.value);
        } else if (op === 'update') {
          await store.update(path, req.value);
        } else if (op === 'remove') {
          await store.remove(path);
        } else {
          return done({ ok: false, error: `Unknown write op: ${op}` });
        }
        return done({ ok: true });
      } catch (err) {
        return done({ ok: false, error: err.message });
      }
    });

    socket.on('rtdb:onDisconnect', (req, ack) => {
      const done = typeof ack === 'function' ? ack : () => {};
      const path = tree.normalizePath(req && req.path);
      const op = req && req.op;
      if (op === 'cancel') {
        disconnectOps.delete(path);
        return done({ ok: true });
      }
      if (!canWrite(socket.uid, path)) {
        return done({ ok: false, error: `Permission denied registering onDisconnect on ${path}` });
      }
      disconnectOps.set(path, { op, value: req.value });
      return done({ ok: true });
    });

    socket.on('disconnect', () => {
      store.removeListener('change', onStoreChange);
      subscriptions.clear();
      disconnectOps.forEach((entry, path) => {
        if (entry.op === 'set') {
          store.set(path, entry.value).catch(() => {});
        } else if (entry.op === 'update') {
          store.update(path, entry.value).catch(() => {});
        } else if (entry.op === 'remove') {
          store.remove(path).catch(() => {});
        }
      });
      disconnectOps.clear();
    });
  });

  Logger.module('SERVER').log('LocalRTDB Socket.IO server attached at /rtdb-socket (/rtdb)');
  return io;
}

module.exports = {
  attachLocalRtdbServer,
  canRead,
  canWrite,
};
