const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function allowNavigation(url, appRoot, realpath = fs.realpathSync) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  const root = path.resolve(appRoot);
  const target = path.resolve(fileURLToPath(parsed));
  let realRoot = root;
  try {
    realRoot = realpath(root);
  } catch {
    return false;
  }
  let realTarget = target;
  try {
    realTarget = realpath(target);
  } catch {
    realTarget = target;
  }
  let stat = null;
  try {
    stat = fs.lstatSync(realTarget);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat && stat.nlink > 1) return false;
  const relative = path.relative(realRoot, realTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = { allowNavigation };
