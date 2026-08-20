'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

let writeQueue = Promise.resolve();

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function loadState(defaultStateFactory) {
  await ensureDataDir();
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const fresh = defaultStateFactory();
    await saveState(fresh);
    return fresh;
  }
}

// Writes are serialized through a queue so concurrent saves can't interleave,
// and each write lands via temp-file-then-rename so a crash mid-write never
// leaves state.json truncated or corrupt.
function saveState(state) {
  writeQueue = writeQueue.then(() => writeStateAtomic(state)).catch((err) => {
    console.error('Failed to persist state:', err);
  });
  return writeQueue;
}

async function writeStateAtomic(state) {
  await ensureDataDir();
  const tmpFile = STATE_FILE + '.tmp' + process.pid;
  await fsp.writeFile(tmpFile, JSON.stringify(state), 'utf8');
  await fsp.rename(tmpFile, STATE_FILE);
}

module.exports = { loadState, saveState, DATA_DIR };
