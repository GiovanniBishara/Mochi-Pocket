'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeProfile } = require('./receipt.cjs');

const PROFILE_FILE = 'receipt-profiles.json';
const MAX_PROFILE_BYTES = 256 * 1024;
const LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

function validProfiles(bytes) {
  if (bytes.length > MAX_PROFILE_BYTES) return false;
  try {
    const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!data || !Array.isArray(data.profiles) || data.profiles.length < 1 || data.profiles.length > 100) return false;
    const profiles = data.profiles.map(normalizeProfile);
    return new Set(profiles.map(profile => profile.id)).size === profiles.length;
  } catch { return false; }
}

async function destinationState(profilePath) {
  try { await fs.lstat(profilePath); return 'present'; }
  catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
}

/** Legacy locations are inspected only; the originals are never changed. */
async function findLegacyProfileDirectories(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) return [];
  const local = path.join(home, 'AppData', 'Local');
  return [path.join(local, 'MochiPocket')];
}

/** Publish complete bytes without replacing any existing destination. */
async function publishProfiles(profilePath, bytes) {
  const temporary = path.join(path.dirname(profilePath), `.receipt-profiles.${randomUUID()}.tmp`);
  let handle;
  try {
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporary, profilePath);
    } catch (error) {
      if (error.code === 'EEXIST') return { status: 'present' };
      if (!LINK_UNSUPPORTED.has(error.code)) throw error;
      // Filesystems without hard links retain the no-overwrite guarantee.
      try { await fs.copyFile(temporary, profilePath, constants.COPYFILE_EXCL); }
      catch (copyError) {
        if (copyError.code === 'EEXIST') return { status: 'present' };
        throw copyError;
      }
    }
    const restored = await fs.readFile(profilePath);
    return restored.equals(bytes) ? { status: 'restored' } : { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
  finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

/** Restore a missing canonical file from the first valid legacy source. */
async function restoreReceiptProfiles({ profilePath, legacyDirs = [], findLegacyDirs } = {}) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath) || !Array.isArray(legacyDirs)
      || (findLegacyDirs !== undefined && typeof findLegacyDirs !== 'function')) {
    return { status: 'unavailable' };
  }
  const state = await destinationState(profilePath);
  if (state !== 'missing') return { status: state };
  if (findLegacyDirs) {
    try { legacyDirs = await findLegacyDirs(); } catch { return { status: 'unavailable' }; }
    if (!Array.isArray(legacyDirs)) return { status: 'unavailable' };
  }
  let unavailable = false;
  const inspected = new Set();
  for (const directory of legacyDirs.slice(0, 32)) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) continue;
    const source = path.join(directory, PROFILE_FILE);
    const key = process.platform === 'win32' ? source.toLowerCase() : source;
    if (inspected.has(key)) continue;
    inspected.add(key);
    let bytes;
    try {
      const info = await fs.stat(source);
      if (!info.isFile() || info.size > MAX_PROFILE_BYTES) { unavailable = true; continue; }
      bytes = await fs.readFile(source);
    } catch (error) {
      if (error.code !== 'ENOENT') unavailable = true;
      continue;
    }
    if (!validProfiles(bytes)) { unavailable = true; continue; }
    return publishProfiles(profilePath, bytes);
  }
  return { status: unavailable ? 'unavailable' : 'missing' };
}

module.exports = { restoreReceiptProfiles, findLegacyProfileDirectories };
