/* eslint-disable no-param-reassign, no-restricted-syntax */
const SERVER_VALUE_TIMESTAMP = { '.sv': 'timestamp' };

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function deepClone(val) {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== 'object') {
    return val;
  }
  return JSON.parse(JSON.stringify(val));
}

function normalizePath(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  let p = raw.trim();
  if (/^https?:\/\//i.test(p)) {
    const idx = p.indexOf('://');
    const slashIdx = p.indexOf('/', idx + 3);
    p = slashIdx >= 0 ? p.slice(slashIdx + 1) : '';
  } else if (/^local:\/\//i.test(p)) {
    p = p.replace(/^local:\/\/[^/]*/i, '');
  }
  // Strip query string or hash if present
  p = p.split('?')[0].split('#')[0];
  return p
    .split('/')
    .filter((seg) => seg.length > 0)
    .join('/');
}

function splitPath(path) {
  const norm = normalizePath(path);
  return norm ? norm.split('/') : [];
}

function joinPath(basePath, childPath) {
  const a = normalizePath(basePath);
  const b = normalizePath(childPath);
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

function getKeyFromPath(path) {
  const segs = splitPath(path);
  return segs.length > 0 ? segs[segs.length - 1] : null;
}

function getParentPath(path) {
  const segs = splitPath(path);
  if (segs.length === 0) return null;
  return segs.slice(0, -1).join('/');
}

function resolveServerValues(val, now) {
  const ts = typeof now === 'number' ? now : Date.now();
  if (val === undefined || val === null) {
    return null;
  }
  if (isPlainObject(val)) {
    if (val['.sv'] === 'timestamp') {
      return ts;
    }
    const out = {};
    let hasKey = false;
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const v = val[k];
      if (v !== undefined && v !== null) {
        const resolved = resolveServerValues(v, ts);
        if (resolved !== null && resolved !== undefined) {
          out[k] = resolved;
          hasKey = true;
        }
      }
    }
    return hasKey ? out : null;
  }
  if (Array.isArray(val)) {
    const arr = val.map((item) => resolveServerValues(item, ts));
    return arr.length > 0 ? arr : null;
  }
  return val;
}

function pruneEmpty(val) {
  if (val === undefined || val === null) {
    return null;
  }
  if (isPlainObject(val)) {
    const keys = Object.keys(val);
    let count = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const cleaned = pruneEmpty(val[k]);
      if (cleaned === null || cleaned === undefined) {
        delete val[k];
      } else {
        val[k] = cleaned;
        count += 1;
      }
    }
    return count > 0 ? val : null;
  }
  return val;
}

function getAtPath(root, segments) {
  let cur = root;
  for (let i = 0; i < segments.length; i += 1) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return null;
    }
    cur = cur[segments[i]];
  }
  return cur === undefined ? null : cur;
}

function setAtPath(root, segments, value) {
  const cleanVal = pruneEmpty(deepClone(value));
  if (segments.length === 0) {
    return cleanVal;
  }
  let base = isPlainObject(root) ? deepClone(root) : {};
  if (cleanVal === null) {
    // Delete along path and prune empty ancestors
    let cur = base;
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (!isPlainObject(cur[segments[i]])) {
        return pruneEmpty(base);
      }
      cur = cur[segments[i]];
    }
    delete cur[segments[segments.length - 1]];
    return pruneEmpty(base);
  }

  let cur = base;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (!isPlainObject(cur[seg])) {
      cur[seg] = {};
    }
    cur = cur[seg];
  }
  cur[segments[segments.length - 1]] = cleanVal;
  base = pruneEmpty(base);
  return base;
}

function updateAtPath(root, segments, updates) {
  if (!isPlainObject(updates)) {
    return setAtPath(root, segments, updates);
  }
  let next = root === undefined ? null : deepClone(root);
  const keys = Object.keys(updates);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const subSegs = segments.concat(splitPath(k));
    next = setAtPath(next, subSegs, updates[k]);
  }
  return next;
}

function compareSortValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const ta = typeof a;
  const tb = typeof b;
  if (ta === 'number' && tb === 'number') {
    return a - b;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function getOrderValue(key, childVal, query) {
  if (!query || !query.orderBy || query.orderBy === 'key') {
    return key;
  }
  if (query.orderBy === 'value') {
    return childVal;
  }
  if (query.orderBy === 'priority') {
    return isPlainObject(childVal) && childVal['.priority'] !== undefined
      ? childVal['.priority']
      : key;
  }
  if (query.orderBy === 'child' && query.orderByChild) {
    return getAtPath(childVal, splitPath(query.orderByChild));
  }
  return key;
}

function applyQuery(val, query) {
  if (!query || !isPlainObject(val)) {
    return val;
  }
  const hasFilter = query.orderBy
    || query.startAt !== undefined
    || query.endAt !== undefined
    || query.equalTo !== undefined
    || query.limitToFirst !== undefined
    || query.limitToLast !== undefined;
  if (!hasFilter) {
    return val;
  }

  let entries = Object.keys(val).map((k) => ({
    key: k,
    val: val[k],
    sortVal: getOrderValue(k, val[k], query),
  }));

  entries.sort((a, b) => {
    const cmp = compareSortValues(a.sortVal, b.sortVal);
    if (cmp !== 0) return cmp;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  if (query.equalTo !== undefined) {
    entries = entries.filter((e) => compareSortValues(e.sortVal, query.equalTo) === 0);
  }
  if (query.startAt !== undefined) {
    entries = entries.filter((e) => compareSortValues(e.sortVal, query.startAt) >= 0);
  }
  if (query.endAt !== undefined) {
    entries = entries.filter((e) => compareSortValues(e.sortVal, query.endAt) <= 0);
  }
  if (typeof query.limitToFirst === 'number' && query.limitToFirst >= 0) {
    entries = entries.slice(0, query.limitToFirst);
  }
  if (typeof query.limitToLast === 'number' && query.limitToLast >= 0) {
    entries = entries.slice(Math.max(0, entries.length - query.limitToLast));
  }

  if (entries.length === 0) {
    return null;
  }
  const out = {};
  for (let i = 0; i < entries.length; i += 1) {
    out[entries[i].key] = entries[i].val;
  }
  return out;
}

function pathsOverlap(pathA, pathB) {
  const a = normalizePath(pathA);
  const b = normalizePath(pathB);
  if (!a || !b) return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function createSnapshot(path, value, refFactory) {
  const norm = normalizePath(path);
  const key = getKeyFromPath(norm);
  const stored = value === undefined ? null : deepClone(value);

  const snap = {
    key,
    val() {
      return deepClone(stored);
    },
    exportVal() {
      return deepClone(stored);
    },
    exists() {
      return stored !== null && stored !== undefined;
    },
    name() {
      return key;
    },
    getPriority() {
      if (isPlainObject(stored) && stored['.priority'] !== undefined) {
        return stored['.priority'];
      }
      return null;
    },
    child(subPath) {
      const childPath = joinPath(norm, subPath);
      const childVal = getAtPath(stored, splitPath(subPath));
      return createSnapshot(childPath, childVal, refFactory);
    },
    hasChild(subPath) {
      return getAtPath(stored, splitPath(subPath)) !== null;
    },
    hasChildren() {
      if (isPlainObject(stored)) {
        return Object.keys(stored).length > 0;
      }
      if (Array.isArray(stored)) {
        return stored.length > 0;
      }
      return false;
    },
    numChildren() {
      if (isPlainObject(stored)) {
        return Object.keys(stored).length;
      }
      if (Array.isArray(stored)) {
        return stored.length;
      }
      return 0;
    },
    forEach(cb) {
      if (typeof cb !== 'function') return false;
      if (isPlainObject(stored)) {
        const keys = Object.keys(stored);
        for (let i = 0; i < keys.length; i += 1) {
          const k = keys[i];
          if (cb(createSnapshot(joinPath(norm, k), stored[k], refFactory)) === true) {
            return true;
          }
        }
      } else if (Array.isArray(stored)) {
        for (let i = 0; i < stored.length; i += 1) {
          if (cb(createSnapshot(joinPath(norm, String(i)), stored[i], refFactory)) === true) {
            return true;
          }
        }
      }
      return false;
    },
  };

  Object.defineProperty(snap, 'ref', {
    enumerable: true,
    get() {
      return typeof refFactory === 'function' ? refFactory(norm) : null;
    },
  });

  return snap;
}

module.exports = {
  SERVER_VALUE_TIMESTAMP,
  isPlainObject,
  deepClone,
  normalizePath,
  splitPath,
  joinPath,
  getKeyFromPath,
  getParentPath,
  resolveServerValues,
  pruneEmpty,
  getAtPath,
  setAtPath,
  updateAtPath,
  applyQuery,
  pathsOverlap,
  createSnapshot,
};
