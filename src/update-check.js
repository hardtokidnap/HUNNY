'use strict';

const LOCAL_VERSION = require('../package.json').version;
const MANIFEST_URL = 'https://raw.githubusercontent.com/hardtokidnap/HUNNY/main/package.json';

function isNewer(remote, local) {
  const r = String(remote).split('.').map(Number);
  const l = String(local).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

// Operator-only notice on stdout. Never throws: an unreachable GitHub or a
// broken manifest must not affect the bot.
async function checkForUpdate() {
  if (/^(false|0|off)$/i.test(process.env.UPDATE_CHECK || '')) return;
  try {
    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { version } = await res.json();
    if (version && isNewer(version, LOCAL_VERSION)) {
      console.warn(
        `[update] v${version} is available (running v${LOCAL_VERSION}). ` +
          'Update with: git pull && docker compose up -d --build',
      );
    }
  } catch (err) {
    console.log(`[update] Version check skipped: ${err.message || err}`);
  }
}

module.exports = { checkForUpdate };
