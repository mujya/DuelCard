import { PassThrough } from 'stream';
import babelify from 'babelify';

// firebase@8 ships ES module browser builds, but browserify only understands
// CommonJS. Transpile just the firebase packages (and leave every other file
// untouched) so `require('firebase/app')` keeps working in the game bundle.
const FIREBASE_PATH = /[\\/]node_modules[\\/](@firebase|firebase)[\\/]/;

export default function firebaseEsm(file, opts) {
  if (!FIREBASE_PATH.test(file)) {
    return new PassThrough();
  }
  // Object.assign (not object spread) because the gulpfile itself is parsed by
  // Babel 6, which cannot parse spread syntax.
  // eslint-disable-next-line prefer-object-spread
  return babelify(file, Object.assign({}, opts, {
    babelrc: false,
    presets: [require.resolve('babel-preset-es2015')],
  }));
}
