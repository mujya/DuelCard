/* eslint-disable max-classes-per-file, no-param-reassign, no-underscore-dangle */
const redis = require('redis');
const { EventEmitter } = require('events');
const config = require('../../../config/config');
const generatePushId = require('../../../app/common/generate_push_id');
const tree = require('../../../app/common/local_rtdb_tree');

const KEY_PREFIX = 'duelyst:rtdb:b:';
const PUBSUB_CHANNEL = 'duelyst:rtdb:events';

// Top-level prefixes that partition data by their second path segment (e.g. users/<uid>)
const TWO_SEGMENT_ROOTS = new Set([
  'users',
  'chat',
  'games-data',
  'matchmaking',
  'telemetry',
  'username-index',
  'email-index',
  'user-ladder-position',
]);

function getBucketInfo(path) {
  const segs = tree.splitPath(path);
  if (segs.length === 0) {
    return { bucket: null, subSegs: [] };
  }
  const rootSeg = segs[0];
  const useTwo = TWO_SEGMENT_ROOTS.has(rootSeg) || rootSeg.startsWith('user-');
  if (useTwo && segs.length >= 2) {
    return {
      bucket: `${segs[0]}/${segs[1]}`,
      subSegs: segs.slice(2),
    };
  }
  return {
    bucket: segs[0],
    subSegs: segs.slice(1),
  };
}

function createRedisClient() {
  const host = config.get('redis.host') || '127.0.0.1';
  const port = config.get('redis.port') || 6379;
  const password = config.get('redis.password') || '';
  const opts = {};
  if (password) {
    opts.auth_pass = password;
  }
  const client = redis.createClient(port, host, opts);
  client.on('error', () => {
    // Avoid unhandled error crashes; redis client auto-reconnects
  });
  return client;
}

class LocalRtdbStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.dataClient = createRedisClient();
    this.txClient = createRedisClient();
    this.subClient = createRedisClient();
    this.pathLocks = new Map();
    this._txQueue = Promise.resolve();

    this.subClient.on('message', (channel, message) => {
      if (channel !== PUBSUB_CHANNEL) return;
      try {
        const evt = JSON.parse(message);
        this.emit('change', evt);
      } catch (e) {
        // Ignore malformed messages
      }
    });
    this.subClient.subscribe(PUBSUB_CHANNEL);
  }

  _enqueueTx(fn) {
    const next = this._txQueue.then(fn, fn);
    this._txQueue = next.then(() => {}, () => {});
    return next;
  }

  // Atomic cross-process read-modify-write on a single Redis bucket using WATCH/MULTI/EXEC
  _mutateBucket(bucket, mutatorFn) {
    const redisKey = `${KEY_PREFIX}${bucket}`;
    const maxRetries = 30;

    return this._enqueueTx(async () => {
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          this.txClient.watch(redisKey, (err) => (err ? reject(err) : resolve()));
        });

        // eslint-disable-next-line no-await-in-loop
        const raw = await new Promise((resolve, reject) => {
          this.txClient.get(redisKey, (err, res) => (err ? reject(err) : resolve(res)));
        });

        let currentDoc = null;
        if (raw) {
          try {
            currentDoc = JSON.parse(raw);
          } catch (e) {
            currentDoc = null;
          }
        }

        const outcome = mutatorFn(currentDoc);
        if (outcome && outcome.abort) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            this.txClient.unwatch(() => resolve());
          });
          return outcome;
        }

        const nextDoc = tree.pruneEmpty(outcome ? outcome.doc : outcome);
        // eslint-disable-next-line no-await-in-loop
        const execRes = await new Promise((resolve, reject) => {
          const multi = this.txClient.multi();
          if (nextDoc === null || nextDoc === undefined) {
            multi.del(redisKey);
          } else {
            multi.set(redisKey, JSON.stringify(nextDoc));
          }
          multi.exec((err, replies) => (err ? reject(err) : resolve(replies)));
        });

        if (execRes !== null) {
          return outcome;
        }
        // WATCH detected a concurrent modification from another process; retry
      }
      throw new Error(`LocalRTDB atomic write retry limit exceeded for bucket ${bucket}`);
    });
  }

  _withLock(lockKey, fn) {
    const prev = this.pathLocks.get(lockKey) || Promise.resolve();
    const next = prev.then(fn, fn);
    const cleanup = () => {
      if (this.pathLocks.get(lockKey) === next) {
        this.pathLocks.delete(lockKey);
      }
    };
    next.then(cleanup, cleanup);
    this.pathLocks.set(lockKey, next);
    return next;
  }

  _getBucket(bucket) {
    return new Promise((resolve, reject) => {
      this.dataClient.get(`${KEY_PREFIX}${bucket}`, (err, raw) => {
        if (err) return reject(err);
        if (!raw) return resolve(null);
        try {
          return resolve(JSON.parse(raw));
        } catch (e) {
          return resolve(null);
        }
      });
    });
  }

  _setBucket(bucket, data) {
    return new Promise((resolve, reject) => {
      const cleaned = tree.pruneEmpty(data);
      if (cleaned === null || cleaned === undefined) {
        this.dataClient.del(`${KEY_PREFIX}${bucket}`, (err) => (err ? reject(err) : resolve()));
      } else {
        this.dataClient.set(`${KEY_PREFIX}${bucket}`, JSON.stringify(cleaned), (err) => (err ? reject(err) : resolve()));
      }
    });
  }

  _keysMatching(pattern) {
    return new Promise((resolve, reject) => {
      this.dataClient.keys(`${KEY_PREFIX}${pattern}`, (err, keys) => {
        if (err) return reject(err);
        return resolve((keys || []).map((k) => k.slice(KEY_PREFIX.length)));
      });
    });
  }

  _publishChange(path) {
    const payload = JSON.stringify({ path: tree.normalizePath(path), ts: Date.now() });
    this.dataClient.publish(PUBSUB_CHANNEL, payload);
  }

  async get(path) {
    const norm = tree.normalizePath(path);
    const segs = tree.splitPath(norm);

    if (segs.length === 0) {
      const buckets = await this._keysMatching('*');
      let root = {};
      for (let i = 0; i < buckets.length; i += 1) {
        const b = buckets[i];
        // eslint-disable-next-line no-await-in-loop
        const val = await this._getBucket(b);
        if (val !== null) {
          root = tree.setAtPath(root, tree.splitPath(b), val) || {};
        }
      }
      return tree.pruneEmpty(root);
    }

    const rootSeg = segs[0];
    const useTwo = TWO_SEGMENT_ROOTS.has(rootSeg) || rootSeg.startsWith('user-');
    if (useTwo && segs.length === 1) {
      const buckets = await this._keysMatching(`${rootSeg}/*`);
      const out = {};
      for (let i = 0; i < buckets.length; i += 1) {
        const b = buckets[i];
        const childKey = b.slice(rootSeg.length + 1);
        // eslint-disable-next-line no-await-in-loop
        const val = await this._getBucket(b);
        if (val !== null) {
          out[childKey] = val;
        }
      }
      return tree.pruneEmpty(out);
    }

    const { bucket, subSegs } = getBucketInfo(norm);
    const doc = await this._getBucket(bucket);
    return tree.getAtPath(doc, subSegs);
  }

  async set(path, rawValue) {
    const norm = tree.normalizePath(path);
    const value = tree.resolveServerValues(rawValue, Date.now());
    const segs = tree.splitPath(norm);

    if (segs.length === 0) {
      // Clear all buckets then re-set top-level keys
      const existing = await this._keysMatching('*');
      await Promise.all(existing.map((b) => this._setBucket(b, null)));
      if (tree.isPlainObject(value)) {
        const topKeys = Object.keys(value);
        for (let i = 0; i < topKeys.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await this.set(topKeys[i], value[topKeys[i]]);
        }
      }
      this._publishChange('');
      return value;
    }

    const rootSeg = segs[0];
    const useTwo = TWO_SEGMENT_ROOTS.has(rootSeg) || rootSeg.startsWith('user-');
    if (useTwo && segs.length === 1) {
      const existing = await this._keysMatching(`${rootSeg}/*`);
      await Promise.all(existing.map((b) => this._setBucket(b, null)));
      if (tree.isPlainObject(value)) {
        const childKeys = Object.keys(value);
        for (let i = 0; i < childKeys.length; i += 1) {
          const ck = childKeys[i];
          // eslint-disable-next-line no-await-in-loop
          await this._setBucket(`${rootSeg}/${ck}`, value[ck]);
        }
      }
      this._publishChange(norm);
      return value;
    }

    const { bucket, subSegs } = getBucketInfo(norm);
    await this._mutateBucket(bucket, (doc) => ({
      doc: tree.setAtPath(doc, subSegs, value),
    }));
    this._publishChange(norm);
    return value;
  }

  async update(path, rawUpdates) {
    const norm = tree.normalizePath(path);
    if (!tree.isPlainObject(rawUpdates)) {
      return this.set(norm, rawUpdates);
    }

    const now = Date.now();
    // Preserve explicit null values so update() can delete keys, while resolving ServerValue.TIMESTAMP
    const entries = Object.keys(rawUpdates).map((k) => {
      const rawV = rawUpdates[k];
      const val = rawV === null || rawV === undefined ? null : tree.resolveServerValues(rawV, now);
      return {
        fullPath: tree.joinPath(norm, k),
        val,
      };
    });
    const byBucket = new Map();
    const fallbackPaths = [];

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const segs = tree.splitPath(entry.fullPath);
      const rootSeg = segs[0];
      const useTwo = rootSeg && (TWO_SEGMENT_ROOTS.has(rootSeg) || rootSeg.startsWith('user-'));
      if (segs.length === 0 || (useTwo && segs.length === 1)) {
        fallbackPaths.push(entry);
      } else {
        const info = getBucketInfo(entry.fullPath);
        if (!byBucket.has(info.bucket)) {
          byBucket.set(info.bucket, []);
        }
        byBucket.get(info.bucket).push({ subSegs: info.subSegs, val: entry.val, fullPath: entry.fullPath });
      }
    }

    for (let i = 0; i < fallbackPaths.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await this.set(fallbackPaths[i].fullPath, fallbackPaths[i].val);
    }

    const bucketEntries = Array.from(byBucket.entries());
    for (let i = 0; i < bucketEntries.length; i += 1) {
      const [bucket, ops] = bucketEntries[i];
      // eslint-disable-next-line no-await-in-loop
      await this._mutateBucket(bucket, (initialDoc) => {
        let doc = initialDoc;
        for (let j = 0; j < ops.length; j += 1) {
          doc = tree.setAtPath(doc, ops[j].subSegs, ops[j].val);
        }
        return { doc };
      });
      for (let j = 0; j < ops.length; j += 1) {
        this._publishChange(ops[j].fullPath);
      }
    }

    return rawUpdates;
  }

  async remove(path) {
    return this.set(path, null);
  }

  async transaction(path, updateFn) {
    const norm = tree.normalizePath(path);
    const { bucket, subSegs } = getBucketInfo(norm);

    if (!bucket) {
      const current = await this.get(norm);
      const result = updateFn(tree.deepClone(current));
      if (result === undefined) {
        return { committed: false, value: current };
      }
      const resolved = tree.resolveServerValues(result, Date.now());
      await this.set(norm, resolved);
      return { committed: true, value: tree.pruneEmpty(resolved) };
    }

    const outcome = await this._mutateBucket(bucket, (doc) => {
      const current = tree.getAtPath(doc, subSegs);
      const result = updateFn(tree.deepClone(current));
      if (result === undefined) {
        return { abort: true, committed: false, value: current };
      }
      const resolved = tree.resolveServerValues(result, Date.now());
      const nextDoc = tree.setAtPath(doc, subSegs, resolved);
      return {
        abort: false,
        committed: true,
        value: tree.pruneEmpty(resolved),
        doc: nextDoc,
      };
    });

    if (outcome.committed) {
      this._publishChange(norm);
    }
    return { committed: !!outcome.committed, value: outcome.value };
  }

  ref(path) {
    return new LocalServerRef(this, tree.normalizePath(path || ''), {});
  }
}

class LocalServerRef {
  constructor(store, path, query) {
    this._store = store;
    this._path = tree.normalizePath(path || '');
    this._query = query || {};
    this._listeners = [];
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
    return p === null ? null : new LocalServerRef(this._store, p, {});
  }

  get root() {
    return new LocalServerRef(this._store, '', {});
  }

  child(subPath) {
    return new LocalServerRef(this._store, tree.joinPath(this._path, subPath), {});
  }

  orderByChild(key) {
    return new LocalServerRef(this._store, this._path, { ...this._query, orderBy: 'child', orderByChild: key });
  }

  orderByKey() {
    return new LocalServerRef(this._store, this._path, { ...this._query, orderBy: 'key' });
  }

  orderByValue() {
    return new LocalServerRef(this._store, this._path, { ...this._query, orderBy: 'value' });
  }

  orderByPriority() {
    return new LocalServerRef(this._store, this._path, { ...this._query, orderBy: 'priority' });
  }

  startAt(val) {
    return new LocalServerRef(this._store, this._path, { ...this._query, startAt: val });
  }

  endAt(val) {
    return new LocalServerRef(this._store, this._path, { ...this._query, endAt: val });
  }

  equalTo(val) {
    return new LocalServerRef(this._store, this._path, { ...this._query, equalTo: val });
  }

  limitToFirst(n) {
    return new LocalServerRef(this._store, this._path, { ...this._query, limitToFirst: n });
  }

  limitToLast(n) {
    return new LocalServerRef(this._store, this._path, { ...this._query, limitToLast: n });
  }

  _makeSnapshot(path, val) {
    return tree.createSnapshot(path, val, (p) => new LocalServerRef(this._store, p, {}));
  }

  set(value, cb) {
    const p = this._store.set(this._path, value);
    if (typeof cb === 'function') {
      p.then(() => cb(null), (err) => cb(err));
    }
    return p;
  }

  setWithPriority(value, priority, cb) {
    const payload = tree.isPlainObject(value) ? { ...value, '.priority': priority } : value;
    return this.set(payload, cb);
  }

  update(updates, cb) {
    const p = this._store.update(this._path, updates);
    if (typeof cb === 'function') {
      p.then(() => cb(null), (err) => cb(err));
    }
    return p;
  }

  remove(cb) {
    const p = this._store.remove(this._path);
    if (typeof cb === 'function') {
      p.then(() => cb(null), (err) => cb(err));
    }
    return p;
  }

  push(value, cb) {
    const id = generatePushId();
    const childRef = this.child(id);
    if (value !== undefined) {
      childRef.set(value, cb);
    }
    return childRef;
  }

  transaction(updateFn, onComplete) {
    const p = this._store.transaction(this._path, updateFn).then(({ committed, value }) => {
      const snap = this._makeSnapshot(this._path, value);
      if (typeof onComplete === 'function') {
        onComplete(null, committed, snap);
      }
      return { committed, snapshot: snap };
    }, (err) => {
      if (typeof onComplete === 'function') {
        onComplete(err, false, null);
      }
      throw err;
    });
    return p;
  }

  once(eventType, cb, cancelCb) {
    const p = this._store.get(this._path).then((raw) => {
      const filtered = tree.applyQuery(raw, this._query);
      const snap = this._makeSnapshot(this._path, filtered);
      if (typeof cb === 'function') {
        cb(snap);
      }
      return snap;
    }, (err) => {
      if (typeof cancelCb === 'function') {
        cancelCb(err);
      }
      throw err;
    });
    return p;
  }

  on(eventType, cb, cancelCb, ctx) {
    const context = typeof cancelCb === 'function' ? ctx : cancelCb;
    let lastVal;
    let initialized = false;

    const emitValue = async () => {
      const raw = await this._store.get(this._path);
      const next = tree.applyQuery(raw, this._query);
      if (eventType === 'value') {
        if (!initialized || JSON.stringify(lastVal) !== JSON.stringify(next)) {
          initialized = true;
          lastVal = tree.deepClone(next);
          cb.call(context, this._makeSnapshot(this._path, next));
        }
        return;
      }

      const prevObj = tree.isPlainObject(lastVal) ? lastVal : {};
      const nextObj = tree.isPlainObject(next) ? next : {};
      const prevKeys = Object.keys(prevObj);
      const nextKeys = Object.keys(nextObj);

      if (eventType === 'child_added') {
        let prevKey = null;
        for (let i = 0; i < nextKeys.length; i += 1) {
          const k = nextKeys[i];
          if (!initialized || !(k in prevObj)) {
            cb.call(context, this._makeSnapshot(tree.joinPath(this._path, k), nextObj[k]), prevKey);
          }
          prevKey = k;
        }
      } else if (eventType === 'child_changed' && initialized) {
        let prevKey = null;
        for (let i = 0; i < nextKeys.length; i += 1) {
          const k = nextKeys[i];
          if (k in prevObj && JSON.stringify(prevObj[k]) !== JSON.stringify(nextObj[k])) {
            cb.call(context, this._makeSnapshot(tree.joinPath(this._path, k), nextObj[k]), prevKey);
          }
          prevKey = k;
        }
      } else if (eventType === 'child_removed' && initialized) {
        for (let i = 0; i < prevKeys.length; i += 1) {
          const k = prevKeys[i];
          if (!(k in nextObj)) {
            cb.call(context, this._makeSnapshot(tree.joinPath(this._path, k), prevObj[k]));
          }
        }
      }

      initialized = true;
      lastVal = tree.deepClone(next);
    };

    const handler = (evt) => {
      if (tree.pathsOverlap(this._path, evt.path)) {
        emitValue().catch(() => {});
      }
    };

    this._store.on('change', handler);
    this._listeners.push({
      eventType,
      cb,
      context,
      handler,
    });
    emitValue().catch(() => {});
    return cb;
  }

  off(eventType, cb) {
    this._listeners = this._listeners.filter((l) => {
      const matchType = !eventType || l.eventType === eventType;
      const matchCb = !cb || l.cb === cb;
      if (matchType && matchCb) {
        this._store.removeListener('change', l.handler);
        return false;
      }
      return true;
    });
  }

  // eslint-disable-next-line class-methods-use-this
  onDisconnect() {
    return {
      set: () => Promise.resolve(),
      update: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    };
  }
}

let singletonStore = null;

function getStore() {
  if (!singletonStore) {
    singletonStore = new LocalRtdbStore();
  }
  return singletonStore;
}

module.exports = {
  LocalRtdbStore,
  LocalServerRef,
  getStore,
  ServerValue: { TIMESTAMP: tree.SERVER_VALUE_TIMESTAMP },
};
