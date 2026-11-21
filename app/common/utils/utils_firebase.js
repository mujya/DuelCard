exports.pathName = function (ref) {
  const parent = typeof ref.parent === 'function' ? ref.parent() : ref.parent;
  let p = null;
  if (parent) {
    p = typeof parent.key === 'string' ? parent.key : parent.name();
  }
  const k = typeof ref.key === 'string' ? ref.key : ref.name();
  return (p ? `${p}/` : '') + k;
};

exports.getNumChildren = function (ref, callback) {
  ref.once('value', (snapshot) => {
    callback(snapshot.numChildren());
  }, callback);
};
