// Node 23+ removed several util.is* helpers that old build tooling
// (gulp-minify-css, rework, etc.) still calls. Restore them before the
// pipeline loads so builds keep working on current Node.
import util from 'util';

if (typeof util.isRegExp !== 'function') util.isRegExp = (v) => v instanceof RegExp;
if (typeof util.isArray !== 'function') util.isArray = Array.isArray;
if (typeof util.isString !== 'function') util.isString = (v) => typeof v === 'string';
if (typeof util.isObject !== 'function') util.isObject = (v) => v !== null && typeof v === 'object';
if (typeof util.isFunction !== 'function') util.isFunction = (v) => typeof v === 'function';
