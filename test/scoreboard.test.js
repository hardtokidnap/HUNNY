'use strict';

// Storage self-check, no framework: `node test/scoreboard.test.js` exits non-zero
// on the first failed assertion.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(os.tmpdir(), `hunny-test-${process.pid}.db`);
fs.rmSync(TMP, { force: true });

// Build a PRE-migration database (guilds without the new columns) plus events,
// so init()'s ALTER+backfill path runs and the seed can be asserted.
const seed = new Database(TMP);
seed.exec(`
  CREATE TABLE guilds (
    guild_id            TEXT PRIMARY KEY,
    honeypot_channel_id TEXT NOT NULL,
    setup_user_id       TEXT NOT NULL,
    anchor_message_id   TEXT,
    log_channel_id      TEXT
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, created_at TEXT NOT NULL,
    level TEXT NOT NULL, tag TEXT NOT NULL, message TEXT NOT NULL
  );
`);
seed
  .prepare(
    'INSERT INTO guilds (guild_id, honeypot_channel_id, setup_user_id, anchor_message_id) VALUES (?,?,?,?)'
  )
  .run('g1', 'chan1', 'user1', 'anchor1');
const ev = seed.prepare(
  'INSERT INTO events (guild_id, created_at, level, tag, message) VALUES (?,?,?,?,?)'
);
ev.run('g1', '2026-06-01T00:00:00.000Z', 'info', 'ban', 'banned a (1)');
ev.run('g1', '2026-06-02T00:00:00.000Z', 'info', 'ban', 'banned b (2)');
ev.run('g1', '2026-06-03T00:00:00.000Z', 'warn', 'ban', 'banning c FAIL'); // not a success
ev.run('g1', '2026-06-04T00:00:00.000Z', 'info', 'detect', 'triggered'); // not a ban
seed.close();

// Point the store at the temp DB BEFORE requiring it (it opens at require time).
process.env.DATABASE_PATH = TMP;
const store = require('../src/stores/sqlite');

(async () => {
  await store.init();

  let g = await store.getGuild('g1');
  assert.strictEqual(g.snipeCount, 2, 'backfill counts only ban/info rows');
  assert.strictEqual(g.lastSnipeAt, '2026-06-02T00:00:00.000Z', 'last_snipe_at = latest ban/info');
  assert.strictEqual(g.scoreboardEnabled, true, 'scoreboard defaults on');
  assert.strictEqual(g.tableflipEnabled, true, 'tableflip egg defaults on after migration');
  assert.strictEqual(g.statsMessageId, null, 'no stats message yet');

  await store.recordSnipe('g1');
  g = await store.getGuild('g1');
  assert.strictEqual(g.snipeCount, 3, 'recordSnipe increments');
  assert.ok(g.lastSnipeAt > '2026-06-02T00:00:00.000Z', 'recordSnipe updates timestamp');

  await store.setScoreboardEnabled('g1', false);
  assert.strictEqual((await store.getGuild('g1')).scoreboardEnabled, false);
  await store.setStatsMessage('g1', 'msg99', 'chan99');
  const withMsg = await store.getGuild('g1');
  assert.strictEqual(withMsg.statsMessageId, 'msg99');
  assert.strictEqual(
    withMsg.statsChannelId,
    'chan99',
    'stats channel persists for cross-channel cleanup'
  );
  await store.setStatsMessage('g1', null, null);
  const cleared = await store.getGuild('g1');
  assert.strictEqual(cleared.statsMessageId, null);
  assert.strictEqual(cleared.statsChannelId, null);

  await store.setTableflipEnabled('g1', false);
  assert.strictEqual((await store.getGuild('g1')).tableflipEnabled, false);
  await store.setTableflipEnabled('g1', true);
  assert.strictEqual((await store.getGuild('g1')).tableflipEnabled, true);

  const { renderScoreboard } = require('../src/scoreboard');
  const withTs = renderScoreboard({
    snipeCount: 42,
    lastSnipeAt: '2026-06-23T10:00:00.000Z',
  }).toJSON();
  const unix = Math.floor(Date.parse('2026-06-23T10:00:00.000Z') / 1000);
  assert.strictEqual(withTs.fields.find((f) => f.name === 'Caught').value, '42');
  assert.strictEqual(withTs.fields.find((f) => f.name === 'Last catch').value, `<t:${unix}:f>`);
  const empty = renderScoreboard({ snipeCount: 0, lastSnipeAt: null }).toJSON();
  assert.strictEqual(empty.fields.find((f) => f.name === 'Last catch').value, 'None yet');

  await store.close();
  fs.rmSync(TMP, { force: true });
  console.log('OK: scoreboard storage self-check passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
