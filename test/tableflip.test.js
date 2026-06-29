'use strict';

// Easter-egg self-check, no framework: `node test/tableflip.test.js` exits
// non-zero on the first failed assertion.
const assert = require('node:assert');
const {
  UNFLIP_SFW,
  UNFLIP_NSFW,
  MAX_TIER,
  MAX_TIER_REPLIES,
  ADVANCE_AFTER,
  EXHAUSTED,
  isTableflip,
  nextState,
  handleTableflip,
  forgetGuild,
  ANGER_RESET_MS,
} = require('../src/tableflip');

const UNFLIP = '┬─┬ノ( º _ ºノ)';

// Trigger: matches a /tableflip with or without the optional leading text, and a
// manually typed flip, but never a plain message or the bot's own upright replies.
assert.ok(isTableflip('(╯°□°）╯︵ ┻━┻'), 'bare /tableflip matches');
assert.ok(isTableflip('gg (╯°□°）╯︵ ┻━┻'), '/tableflip with option text matches');
assert.ok(isTableflip('(ノಠ益ಠ)ノ彡┻━┻'), 'manual flip variant matches');
assert.ok(!isTableflip('just chatting'), 'plain message ignored');
assert.ok(!isTableflip(UNFLIP), 'upright reply never self-triggers');

// Data contract: both tables carry the full tier range, every variant (plus the
// exhausted notice) carries the unflip emoji, no tier is empty (pick() would be undefined).
for (const [name, table] of [
  ['SFW', UNFLIP_SFW],
  ['NSFW', UNFLIP_NSFW],
]) {
  assert.strictEqual(table.length, MAX_TIER + 1, `${name} table has every tier`);
  table.forEach((tier, i) => {
    assert.ok(tier.length > 0, `${name} tier ${i} has no variants`);
    tier.forEach((line) => {
      assert.ok(line.includes(UNFLIP), `${name} tier ${i} missing unflip emoji: ${line}`);
    });
  });
}
assert.ok(EXHAUSTED.includes('(ツ)'), 'exhausted notice shows the shrug');
assert.strictEqual(ADVANCE_AFTER.length, MAX_TIER, 'one advance threshold per non-max tier');

// SFW table carries neither profanity nor violence (plain "damn" is allowed). Long words are
// prefix-matched so conjugations trip; short lookalikes (ass/cock/stab) are boundaried to spare innocents.
const PROFANITY =
  /\b(?:fuck|shit|bitch|goddamn|cunt|piss|bastard|asshole|dumbass|jackass|dipshit|wank|bollock|douche)|\b(?:cock|dick|prick|twat|ass)(?:es|s|head)?\b/i;
const VIOLENCE =
  /\b(?:dying|gut|kill|murder|slit|behead|maim|strangle|choke|slaughter|corpse|bleed|blood|throat)|\bstab(?:s|bed|bing)?\b/i;
UNFLIP_SFW.forEach((tier, i) => {
  tier.forEach((line) => {
    assert.ok(!PROFANITY.test(line), `SFW tier ${i} leaks profanity: ${line}`);
    assert.ok(!VIOLENCE.test(line), `SFW tier ${i} leaks a violent line: ${line}`);
  });
});
for (let t = 4; t <= MAX_TIER; t++) {
  assert.notDeepStrictEqual(UNFLIP_SFW[t], UNFLIP_NSFW[t], `tier ${t} twins should differ`);
}

// Drive 70 rapid flips (1s apart, well inside the reset window) and capture each state.
const states = [];
let prev;
let now = 1000;
for (let i = 0; i < 70; i++) {
  now += 1000;
  prev = nextState(prev, now);
  states.push(prev);
}
const at = (flip) => states[flip - 1];

// Each tier holds for ADVANCE_AFTER[tier] flips, then the next flip shows the next tier.
let flip = 0;
for (let tier = 0; tier < MAX_TIER; tier++) {
  for (let k = 0; k < ADVANCE_AFTER[tier]; k++) {
    flip += 1;
    assert.strictEqual(at(flip).action, 'tier', `flip ${flip} should reply`);
    assert.strictEqual(at(flip).replyTier, tier, `flip ${flip} should show tier ${tier}`);
  }
}
// Next come the max-tier replies, then one exhausted notice, then silence.
for (let k = 0; k < MAX_TIER_REPLIES; k++) {
  flip += 1;
  assert.strictEqual(at(flip).action, 'tier', `flip ${flip} max-tier reply`);
  assert.strictEqual(at(flip).replyTier, MAX_TIER, `flip ${flip} shows max tier`);
}
flip += 1;
assert.strictEqual(at(flip).action, 'exhausted', `flip ${flip} is the exhausted notice`);
flip += 1;
assert.strictEqual(at(flip).action, 'none', `flip ${flip} is silent`);

// The exhausted notice fires exactly once for the whole streak.
assert.strictEqual(
  states.filter((s) => s.action === 'exhausted').length,
  1,
  'exhausted notice sends only once'
);

// While flips keep coming the egg stays silent, and each one refreshes the cooldown timer.
assert.ok(at(66).lastFlip > at(65).lastFlip, 'each silent flip pushes the cooldown out');
const stillSpamming = nextState(at(70), at(70).lastFlip + 1000);
assert.strictEqual(stillSpamming.action, 'none', 'continued spamming stays silent');

// Only 60s with no flips wakes it back up at the calm tier.
const reset = nextState(at(70), at(70).lastFlip + ANGER_RESET_MS);
assert.strictEqual(reset.tier, 0, 'cooldown resets to tier 0 after 60s of quiet');
assert.strictEqual(reset.action, 'tier', 'replies again after the quiet period');
assert.strictEqual(reset.replyTier, 0, 'back to the calm tier');

// An idle gap at any tier also resets to calm.
const idle = nextState({ tier: MAX_TIER, count: 99, lastFlip: 0 }, ANGER_RESET_MS);
assert.strictEqual(idle.tier, 0, 'idle gap resets to tier 0');

// Handler-level: exercise the honeypot skip, fail-closed, send, and forgetGuild paths
// with a fake message + store (no Discord client).
function fakeMessage(guildId, channelId, content) {
  const sent = [];
  const msg = {
    author: { bot: false },
    system: false,
    guildId,
    channelId,
    content,
    channel: { nsfw: false, send: async (text) => sent.push(text) },
  };
  return { msg, sent };
}

const trapStore = { getGuild: async () => ({ honeypotChannelId: 'trap' }) };
const errStore = {
  getGuild: async () => {
    throw new Error('db down');
  },
};

(async () => {
  const flipText = '(╯°□°）╯︵ ┻━┻';

  const send = fakeMessage('h-send', 'general', flipText);
  await handleTableflip(send.msg, trapStore);
  assert.strictEqual(send.sent.length, 1, 'flip in a normal channel replies once');
  assert.ok(send.sent[0].includes(UNFLIP), 'reply carries the unflip emoji');

  const trap = fakeMessage('h-trap', 'trap', flipText);
  await handleTableflip(trap.msg, trapStore);
  assert.strictEqual(trap.sent.length, 0, 'flip in the trap channel is left to the honeypot');

  const errored = fakeMessage('h-err', 'general', flipText);
  await handleTableflip(errored.msg, errStore);
  assert.strictEqual(errored.sent.length, 0, 'store error fails closed, no reply');

  const plain = fakeMessage('h-noop', 'general', 'hello world');
  await handleTableflip(plain.msg, trapStore);
  assert.strictEqual(plain.sent.length, 0, 'plain message ignored');

  const disabledStore = {
    getGuild: async () => ({ honeypotChannelId: 'trap', tableflipEnabled: false }),
  };
  const disabled = fakeMessage('h-off', 'general', flipText);
  await handleTableflip(disabled.msg, disabledStore);
  assert.strictEqual(disabled.sent.length, 0, 'disabled guild stays silent');

  forgetGuild('h-send');
  const again = fakeMessage('h-send', 'general', flipText);
  await handleTableflip(again.msg, trapStore);
  assert.strictEqual(again.sent.length, 1, 'flip replies again after forgetGuild');

  // Routing: a non-NSFW channel must never emit a profane line, even spammed to peak anger.
  const sfw = fakeMessage('h-sfw', 'general', flipText);
  for (let i = 0; i < 64; i++) await handleTableflip(sfw.msg, trapStore);
  assert.ok(sfw.sent.length > MAX_TIER, 'climbed through the tiers');
  sfw.sent.forEach((line) => {
    assert.ok(!PROFANITY.test(line), `non-NSFW channel leaked profanity: ${line}`);
  });

  console.log('OK: tableflip easter-egg self-check passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
