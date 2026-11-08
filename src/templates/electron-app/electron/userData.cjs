const path = require('node:path');

function userDataDir(appDir, previewReady) {
  const root = path.resolve(appDir);
  if (typeof previewReady === 'string' && path.isAbsolute(previewReady)) return path.join(root, '.preview-data');
  return path.join(root, '.app-data');
}

module.exports = { userDataDir };
