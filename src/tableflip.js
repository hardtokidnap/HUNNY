'use strict';

// Discord's /tableflip posts a normal message ending in this glyph (with or without
// the optional leading text); upright replies use ┬─┬, so matching it never self-triggers.
const FLIPPED_TABLE = '┻━┻';
const ANGER_RESET_MS = 60_000;

// Tiers 0-3 are clean and shared by both audiences.
const TIERS_CLEAN = [
  // Tier 0: calm, polite
  [
    'There we go, all tidy again. ┬─┬ノ( º _ ºノ)',
    "No worries, I've got it. ┬─┬ノ( º _ ºノ)",
    'Table restored. Have a lovely day. ┬─┬ノ( º _ ºノ)',
    'Oops, let me fix that for you. ┬─┬ノ( º _ ºノ)',
    'Back where it belongs. ┬─┬ノ( º _ ºノ)',
    'table_service: restored to upright. ┬─┬ノ( º _ ºノ)',
    'Auto-correcting furniture orientation. ┬─┬ノ( º _ ºノ)',
    '[INFO] table.flip detected, reverting. ┬─┬ノ( º _ ºノ)',
    'Table reset successful, exit code 0. ┬─┬ノ( º _ ºノ)',
    'There is no flipped table. Only one you imagine. ┬─┬ノ( º _ ºノ)',
    "I'm afraid I can't let you leave it like that, Dave. ┬─┬ノ( º _ ºノ)",
    'Keep calm and let me carry the table. ┬─┬ノ( º _ ºノ)',
    'Wingardium Leviosa, the table rises gently. ┬─┬ノ( º _ ºノ)',
    'It does not do to dwell on flipped tables. Up it goes. ┬─┬ノ( º _ ºノ)',
    'Tread lightly, and the table will too. ┬─┬ノ( º _ ºノ)',
    'Jesse! We need to unflip tables. ┬─┬ノ( º _ ºノ)',
    'A table is never late, nor early. It arrives precisely upright. ┬─┬ノ( º _ ºノ)',
    'My precious... table. ┬─┬ノ( º _ ºノ)',
    'Even the smallest table can change the course of the future. ┬─┬ノ( º _ ºノ)',
    "These aren't the tables you're looking for. ┬─┬ノ( º _ ºノ)",
    'Do. Or do not. There is no flip. ┬─┬ノ( º _ ºノ)',
    'The table is strong with this one. ┬─┬ノ( º _ ºノ)',
    "Hello there. Table's upright. ┬─┬ノ( º _ ºノ)",
    'As you wish. The table goes back up. ┬─┬ノ( º _ ºノ)',
    "Here's looking at you, table. ┬─┬ノ( º _ ºノ)",
    'My mama always said the table goes back up. ┬─┬ノ( º _ ºノ)',
    "It's dangerous to flip alone. Take this table. ┬─┬ノ( º _ ºノ)",
    'The cake is a lie, but the table is upright. ┬─┬ノ( º _ ºノ)',
    "It ain't much, but it's an honest table. ┬─┬ノ( º _ ºノ)",
    'Task failed successfully: table is up. ┬─┬ノ( º _ ºノ)',
    '404: flipped table not found. ┬─┬ノ( º _ ºノ)',
    'And just like that, the table was upright again. ┬─┬ノ( º _ ºノ)',
    'After all this time? Always righting it. ┬─┬ノ( º _ ºノ)',
    'Wax on, table up. ┬─┬ノ( º _ ºノ)',
    "There's no place like an upright table. ┬─┬ノ( º _ ºノ)",
    "Toto, I've a feeling this table isn't flipped anymore. ┬─┬ノ( º _ ºノ)",
    'One does not simply flip a table. ┬─┬ノ( º _ ºノ)',
    "Hey, you're finally awake. You were trying to flip that table, right? ┬─┬ノ( º _ ºノ)",
    'Leave the gun, take the table. ┬─┬ノ( º _ ºノ)',
    '*Long drawn sigh* ┬─┬ノ( º _ ºノ)',
    'There is no spoon cause you flipped it off the table. ┬─┬ノ( º _ ºノ)',
  ],
  // Tier 1: mild
  [
    'Again? Alright, up it goes. ┬─┬ノ( º _ ºノ)',
    "That's two. I'm counting now. ┬─┬ノ( º _ ºノ)",
    'You good? The table is fine. ┬─┬ノ( º _ ºノ)',
    "Putting this back, just so we're clear. ┬─┬ノ( º _ ºノ)",
    'Cute. Fixed it anyway. ┬─┬ノ( º _ ºノ)',
    "[WARN] repeated flip detected, that's two. ┬─┬ノ( º _ ºノ)",
    'Incrementing flip_counter, just so you know. ┬─┬ノ( º _ ºノ)',
    'Table integrity: fine. Your behavior: noted. ┬─┬ノ( º _ ºノ)',
    "I'll be back. The table never left. ┬─┬ノ( º _ ºノ)",
    "You're gonna need a bigger table. ┬─┬ノ( º _ ºノ)",
    'I find your lack of respect for this table disturbing. ┬─┬ノ( º _ ºノ)',
    'Frankly my dear, I do give a damn about this table. ┬─┬ノ( º _ ºノ)',
    "Reparo. That's twice now, just noting it. ┬─┬ノ( º _ ºノ)",
    'I solemnly swear you are up to no good. ┬─┬ノ( º _ ºノ)',
    'Yeah, science! The table goes back up. ┬─┬ノ( º _ ºノ)',
    "Better call s(aul)omeone, because I'm righting it again. ┬─┬ノ( º _ ºノ)",
    'Fly, you fools. The table stays. ┬─┬ノ( º _ ºノ)',
    'I am your father. Put the table down. ┬─┬ノ( º _ ºノ)',
    'Inconceivable. The table is upright. ┬─┬ノ( º _ ºノ)',
    'Nobody puts the table in the corner. ┬─┬ノ( º _ ºノ)',
    'Come with me if you want your table upright. ┬─┬ノ( º _ ºノ)',
    'Perfectly balanced, as all tables should be. ┬─┬ノ( º _ ºノ)',
    'I am Groot. (Translation: stop flipping the table.) ┬─┬ノ( º _ ºノ)',
    'I used to flip tables like you, then I took an arrow to the knee. ┬─┬ノ( º _ ºノ)',
    'All your table are belong to us. ┬─┬ノ( º _ ºノ)',
    'A Lannister always rights his tables. ┬─┬ノ( º _ ºノ)',
    'When you play the game of tables, you flip or you right. ┬─┬ノ( º _ ºノ)',
    "I drink and I right tables. That's what I do. ┬─┬ノ( º _ ºノ)",
    'This is fine. The table is on fire but upright. ┬─┬ノ( º _ ºノ)',
    'Modern problems require modern table righting. ┬─┬ノ( º _ ºノ)',
    "It's leviOsa, not levioSAH, and the table goes up. ┬─┬ノ( º _ ºノ)",
    'Just keep flipping. No wait, stop. ┬─┬ノ( º _ ºノ)',
    'Press F to pay respects. Then I right the table. ┬─┬ノ( º _ ºノ)',
    "It's free real estate. The table is mine now. ┬─┬ノ( º _ ºノ)",
    "He's right behind me, isn't he. The table. ┬─┬ノ( º _ ºノ)",
    'Do a barrel roll, not a table flip. ┬─┬ノ( º _ ºノ)',
    'Stonks, but for table righting. ┬─┬ノ( º _ ºノ)',
    'With great power comes great table responsibility. ┬─┬ノ( º _ ºノ)',
    "You're a table flipper. Table flippers make me thirsty. ┬─┬ノ( º _ ºノ)",
  ],
  // Tier 2: growing irritation
  [
    "Okay this is becoming a thing, isn't it. ┬─┬ノ( º _ ºノ)",
    'The table did nothing to you. ┬─┬ノ( º _ ºノ)',
    'I have other tables to manage, you know. ┬─┬ノ( º _ ºノ)',
    'Real mature. Up it goes. ┬─┬ノ( º _ ºノ)',
    "We're really doing this today, huh. ┬─┬ノ( º _ ºノ)",
    '[WARN] this loop is starting to chafe. ┬─┬ノ( º _ ºノ)',
    'My uptime was peaceful before you showed up. ┬─┬ノ( º _ ºノ)',
    'throw new TableFlipException(again). ┬─┬ノ( º _ ºノ)',
    'Houston, we have a furniture problem. ┬─┬ノ( º _ ºノ)',
    'You keep using that flip. I do not appreciate it. ┬─┬ノ( º _ ºノ)',
    "I'm getting too old for this table. ┬─┬ノ( º _ ºノ)",
    "We're really stress-testing me today, huh. ┬─┬ノ( º _ ºノ)",
    'Are you a wizard or just bored? Up it goes. ┬─┬ノ( º _ ºノ)',
    "Ten points from whatever house you're in. ┬─┬ノ( º _ ºノ)",
    'Say my name. No? Then stop flipping my table. ┬─┬ノ( º _ ºノ)',
    "This is not meth, it's a table, and you'll respect it. ┬─┬ノ( º _ ºノ)",
    'So this is how the table dies, with thunderous flipping. ┬─┬ノ( º _ ºノ)',
    'I am inevitable. The table rights itself. ┬─┬ノ( º _ ºノ)',
    'Would you kindly stop flipping the table? ┬─┬ノ( º _ ºノ)',
    'War. War never changes. Tables, though, I keep changing back. ┬─┬ノ( º _ ºノ)',
    "Sir, this is a Wendy's, and that's a table. ┬─┬ノ( º _ ºノ)",
    'Why is the rum table gone? ┬─┬ノ( º _ ºノ)',
    'Objection. That table was flipped illegally. ┬─┬ノ( º _ ºノ)',
    "Keep flipping and I'll have to eat every chicken in this room. ┬─┬ノ( º _ ºノ)",
    'I came here to eat, not to right your table all night. ┬─┬ノ( º _ ºノ)',
    'There is no table flips in Ba Sing Se. ┬─┬ノ( º _ ºノ)',
  ],
  // Tier 3: visibly annoyed
  [
    'Seriously? Knock it off. ┬─┬ノ( º _ ºノ)',
    'I am not your unflipping servant. ┬─┬ノ( º _ ºノ)',
    'My patience and this table are both wobbling. ┬─┬ノ( º _ ºノ)',
    'Every time. Every single time. ┬─┬ノ( º _ ºノ)',
    '[ERROR] patience module not responding. ┬─┬ノ( º _ ºノ)',
    'Memory leak detected: my will to live. ┬─┬ノ( º _ ºノ)',
    'Knock it off before I log you to /dev/null. ┬─┬ノ( º _ ºノ)',
    'You shall not flip. ┬─┬ノ( º _ ºノ)',
    'I have a particular set of skills. Righting tables is one. ┬─┬ノ( º _ ºノ)',
    "Are you not entertained? It's a table. ┬─┬ノ( º _ ºノ)",
    'Why so serious about this poor table? ┬─┬ノ( º _ ºノ)',
    'You have my attention now, and not the good kind. ┬─┬ノ( º _ ºノ)',
    'There will be no foolish flipping in my server. ┬─┬ノ( º _ ºノ)',
    'Have you no shame? The table has done nothing. ┬─┬ノ( º _ ºノ)',
    'I am the danger, and the danger keeps fixing your table. ┬─┬ノ( º _ ºノ)',
    "You clearly don't know who you're flipping at. ┬─┬ノ( º _ ºノ)",
    'I can do this all day. ┬─┬ノ( º _ ºノ)',
    'Hello. My name is Inigo Montoya. You flipped my table. Prepare to be unflipped. ┬─┬ノ( º _ ºノ)',
    'Snake? Snake?! SNAAAKE ┬─┬ノ( º _ ºノ)',
    "Keep flipping. We'll see who runs out of patience first. ┬─┬ノ( º _ ºノ)",
    'Consequences, meet Actions. Actions, meet Consequences. ┬─┬ノ( º _ ºノ)',
    'Flip it again and I ragebait a VRChat furry into this channel. ┬─┬ノ( º _ ºノ)',
  ],
];

// Tiers 4-6 come in clean (SFW) and profane (NSFW) twins: same jokes, profanity swapped.
const TIER_4_SFW = [
  'Leave the dang table alone already. ┬─┬ノ( º _ ºノ)',
  'Oh my gosh, get a new bit. ┬─┬ノ( º _ ºノ)',
  "I'm sick of your nonsense, sit down. ┬─┬ノ( º _ ºノ)",
  "The table has feelings and you're hurting them. ┬─┬ノ( º _ ºノ)",
  '[FATAL] leave the dang table alone. ┬─┬ノ( º _ ºノ)',
  'rm -rf this behavior, please. ┬─┬ノ( º _ ºノ)',
  'Touch it again and I deprecate you. ┬─┬ノ( º _ ºノ)',
  'My rage daemon just spawned a child process. ┬─┬ノ( º _ ºノ)',
  'Say flip one more dang time, I dare you. ┬─┬ノ( º _ ºノ)',
  "I'm sick of these dang tables in this server. ┬─┬ノ( º _ ºノ)",
  'Say hello to my little table leg. ┬─┬ノ( º _ ºノ)',
  "You can't handle the table. ┬─┬ノ( º _ ºノ)",
  'Not my table, you absolute house-elf reject. ┬─┬ノ( º _ ºノ)',
  "I'm warning you, leave the blasted table alone. ┬─┬ノ( º _ ºノ)",
  'Stay out of my territory, that table is mine. ┬─┬ノ( º _ ºノ)',
  'SAY MY NAME and put the table down. ┬─┬ノ( º _ ºノ)',
  'Hasta la vista, flipper. ┬─┬ノ( º _ ºノ)',
  "Flip it one more time and we'll see how this goes for you. ┬─┬ノ( º _ ºノ)",
];
const TIER_4_NSFW = [
  'Leave the damn table alone already. ┬─┬ノ( º _ ºノ)',
  'Oh my god, get a new bit. ┬─┬ノ( º _ ºノ)',
  "I'm sick of your shit, sit down. ┬─┬ノ( º _ ºノ)",
  "The table has feelings and you're hurting them. ┬─┬ノ( º _ ºノ)",
  '[FATAL] leave the damn table alone. ┬─┬ノ( º _ ºノ)',
  'rm -rf this behavior, please. ┬─┬ノ( º _ ºノ)',
  'Touch it again and I deprecate you. ┬─┬ノ( º _ ºノ)',
  'My rage daemon just spawned a child process. ┬─┬ノ( º _ ºノ)',
  'Say flip one more goddamn time, I dare you. ┬─┬ノ( º _ ºノ)',
  "I'm sick of these motherflipping tables in this server. ┬─┬ノ( º _ ºノ)",
  'Say hello to my little table leg. ┬─┬ノ( º _ ºノ)',
  "You can't handle the table. ┬─┬ノ( º _ ºノ)",
  'Not my table, you absolute house-elf reject. ┬─┬ノ( º _ ºノ)',
  "I'm warning you, leave the bloody table alone. ┬─┬ノ( º _ ºノ)",
  'Stay out of my territory, that table is mine. ┬─┬ノ( º _ ºノ)',
  'SAY MY DAMN NAME and put the table down. ┬─┬ノ( º _ ºノ)',
  'Hasta la vista, flipper. ┬─┬ノ( º _ ºノ)',
  "Flip it one more damn time and we'll see how you do at dying. ┬─┬ノ( º _ ºノ)",
];

const TIER_5_SFW = [
  "Leave the freaking table alone, I'm begging. ┬─┬ノ( º _ ºノ)",
  "What is WRONG with you, it's furniture. ┬─┬ノ( º _ ºノ)",
  'Do you flip tables at home too, animal? ┬─┬ノ( º _ ºノ)',
  'Stop. Touching. My. Freaking. Table. ┬─┬ノ( º _ ºノ)',
  'Leave the freaking table alone, this is a 429. ┬─┬ノ( º _ ºノ)',
  'Rate limit exceeded: you, specifically. ┬─┬ノ( º _ ºノ)',
  'I will segfault on purpose to escape you. ┬─┬ノ( º _ ºノ)',
  "stack overflow, and it's ALL your fault. ┬─┬ノ( º _ ºノ)",
  "Billing API is live, I'm charging per flip now. ┬─┬ノ( º _ ºノ)",
  'Flip me once, shame on you. Flip me ten times, eat dirt. ┬─┬ノ( º _ ºノ)',
  'I see this table in my freaking dreams now, thanks. ┬─┬ノ( º _ ºノ)',
  'We are not so different, you and this rage I now feel. ┬─┬ノ( º _ ºノ)',
  'NOT MY TABLE, YOU MENACE. ┬─┬ノ( º _ ºノ)',
  'Fifty points and a detention, flip again. ┬─┬ノ( º _ ºノ)',
  'I am awake now, and I am the one who knocks. ┬─┬ノ( º _ ºノ)',
  'Stay away from my table, you walking disaster. ┬─┬ノ( º _ ºノ)',
  "They may take our lives, but they'll never take our TABLE. ┬─┬ノ( º _ ºノ)",
  "You're bad at flipping and you'll be worse at running. Sit down. ┬─┬ノ( º _ ºノ)",
];
const TIER_5_NSFW = [
  "Leave the fucking table alone, I'm begging. ┬─┬ノ( º _ ºノ)",
  "What is WRONG with you, it's furniture. ┬─┬ノ( º _ ºノ)",
  'Do you flip tables at home too, animal? ┬─┬ノ( º _ ºノ)',
  'Stop. Touching. My. Goddamn. Table. ┬─┬ノ( º _ ºノ)',
  'Leave the fucking table alone, this is a 429. ┬─┬ノ( º _ ºノ)',
  'Rate limit exceeded: you, specifically. ┬─┬ノ( º _ ºノ)',
  'I will segfault on purpose to escape you. ┬─┬ノ( º _ ºノ)',
  "stack overflow, and it's ALL your fault. ┬─┬ノ( º _ ºノ)",
  "Billing API is live, I'm charging per flip now. ┬─┬ノ( º _ ºノ)",
  'Flip me once, shame on you. Flip me ten times, eat shit. ┬─┬ノ( º _ ºノ)',
  'I see this table in my fucking dreams now, thanks. ┬─┬ノ( º _ ºノ)',
  'We are not so different, you and this rage I now feel. ┬─┬ノ( º _ ºノ)',
  'NOT MY TABLE, YOU BITCH. ┬─┬ノ( º _ ºノ)',
  'Fifty points and a fucking detention, flip again. ┬─┬ノ( º _ ºノ)',
  'I am awake now, and I am the one who fucking knocks. ┬─┬ノ( º _ ºノ)',
  'Stay the hell out of my table, you junkie menace. ┬─┬ノ( º _ ºノ)',
  "They may take our lives, but they'll never take our TABLE. ┬─┬ノ( º _ ºノ)",
  "You're shit at flipping and you'll be worse at running. Sit down. ┬─┬ノ( º _ ºノ)",
];

const TIER_6_SFW = [
  "THAT'S IT. THE TABLE AND I ARE PRESSING CHARGES. ┬─┬ノ( º _ ºノ)",
  'FLIP IT AGAIN AND I SWEAR TO GOD I WILL FLIP YOU ┬─┬ノ( º _ ºノ)',
  'GO TO BED. TOPPLE SOMETHING IN YOUR DREAMS. ┬─┬ノ( º _ ºノ)',
  'I AM A BOT AND YOU HAVE GIVEN ME RAGE. CONGRATS. ┬─┬ノ( º _ ºノ)',
  'KERNEL PANIC: TABLE SUBSYSTEM HAS HAD ENOUGH ┬─┬ノ( º _ ºノ)',
  "FATAL EXCEPTION IN THREAD 'YOUR_NONSENSE' ┬─┬ノ( º _ ºノ)",
  'CORE DUMPED. RAGE NOT DUMPED. FLIP AGAIN, I DARE YOU ┬─┬ノ( º _ ºノ)',
  "HEEEERE'S THE UPRIGHT TABLE. ┬─┬ノ( º _ ºノ)",
  "I'M MAD AS HECK AND I'M STILL RIGHTING THIS THING ┬─┬ノ( º _ ºノ)",
  'THIS. IS. A. TABLE. ┬─┬ノ( º _ ºノ)',
  'FREEDOM FOR THE TABLE, YOU ABSOLUTE MENACE ┬─┬ノ( º _ ºノ)',
  'THERE IS NO FLIPPING, NO RIGHTING, ONLY THE TABLE AND I ┬─┬ノ( º _ ºノ)',
  'I AM LORD VOLDETABLE AND I COMMAND IT UPRIGHT ┬─┬ノ( º _ ºノ)',
  'AVADA KETABLEVRA, YOUR FLIPPING ENDS NOW ┬─┬ノ( º _ ºノ)',
  "SAY MY NAME. I AM HEISENTABLE. YOU'RE DARN RIGHT. ┬─┬ノ( º _ ºノ)",
  'I AM THE ONE WHO FLIPS. STOP. FLIPPING. MY. TABLE. ┬─┬ノ( º _ ºノ)',
  "I'VE RAGEQUIT OVER LESS THAN A FLIPPED TABLE. UP. NOW. ┬─┬ノ( º _ ºノ)",
];
const TIER_6_NSFW = [
  "THAT'S IT. THE TABLE AND I ARE PRESSING CHARGES. ┬─┬ノ( º _ ºノ)",
  'FLIP IT AGAIN AND I SWEAR TO GOD I WILL FLIP YOU ┬─┬ノ( º _ ºノ)',
  'GO TO BED. TOPPLE SOMETHING IN YOUR DREAMS. ┬─┬ノ( º _ ºノ)',
  'I AM A BOT AND YOU HAVE GIVEN ME RAGE. CONGRATS. ┬─┬ノ( º _ ºノ)',
  'KERNEL PANIC: TABLE SUBSYSTEM HAS HAD ENOUGH ┬─┬ノ( º _ ºノ)',
  "FATAL EXCEPTION IN THREAD 'YOUR_BULLSHIT' ┬─┬ノ( º _ ºノ)",
  'CORE DUMPED. RAGE NOT DUMPED. FLIP AGAIN, I DARE YOU ┬─┬ノ( º _ ºノ)',
  "HEEEERE'S THE UPRIGHT TABLE. ┬─┬ノ( º _ ºノ)",
  "I'M MAD AS HELL AND I'M STILL RIGHTING THIS THING ┬─┬ノ( º _ ºノ)",
  'THIS. IS. A. TABLE. ┬─┬ノ( º _ ºノ)',
  'FREEDOM FOR THE TABLE, YOU ABSOLUTE MENACE ┬─┬ノ( º _ ºノ)',
  'THERE IS NO FLIPPING, NO RIGHTING, ONLY THE TABLE AND I ┬─┬ノ( º _ ºノ)',
  'I AM LORD VOLDETABLE AND I COMMAND IT UPRIGHT ┬─┬ノ( º _ ºノ)',
  'AVADA KETABLEVRA, YOUR FLIPPING ENDS NOW ┬─┬ノ( º _ ºノ)',
  "SAY MY NAME. I AM HEISENTABLE. YOU'RE GODDAMN RIGHT. ┬─┬ノ( º _ ºノ)",
  'I AM THE ONE WHO FLIPS. STOP. FLIPPING. MY. TABLE. ┬─┬ノ( º _ ºノ)',
  "I'VE GUTTED MEN OVER LESS THAN A FLIPPED TABLE. UP. NOW. ┬─┬ノ( º _ ºノ)",
];

const UNFLIP_SFW = [...TIERS_CLEAN, TIER_4_SFW, TIER_5_SFW, TIER_6_SFW];
const UNFLIP_NSFW = [...TIERS_CLEAN, TIER_4_NSFW, TIER_5_NSFW, TIER_6_NSFW];

const MAX_TIER = UNFLIP_NSFW.length - 1;
const MAX_TIER_REPLIES = 3;
// Flips needed at tier i before advancing to i+1; later tiers fire faster.
const ADVANCE_AFTER = [15, 15, 10, 10, 5, 5];
const EXHAUSTED =
  'System message: unflip tokens exhausted. Rate limited, try again later. ¯\\_(ツ)_/¯';

const anger = new Map(); // bounded by guild count, cleared on guildDelete and process restart

// action 'tier' picks UNFLIP_RESPONSES[replyTier], 'exhausted' sends EXHAUSTED once, then 'none'
// stays silent; each silent flip refreshes lastFlip, so the egg only resets after 60s with no flips.
function nextState(prev, now, resetMs = ANGER_RESET_MS) {
  if (!prev || now - prev.lastFlip >= resetMs) {
    return { tier: 0, count: 1, lastFlip: now, action: 'tier', replyTier: 0 };
  }

  let { tier, count } = prev;
  count += 1;

  if (tier < MAX_TIER) {
    const replyTier = tier;
    if (count >= ADVANCE_AFTER[tier]) {
      tier += 1;
      count = 0;
    }
    return { tier, count, lastFlip: now, action: 'tier', replyTier };
  }

  if (count <= MAX_TIER_REPLIES) {
    return { tier, count, lastFlip: now, action: 'tier', replyTier: MAX_TIER };
  }
  if (count === MAX_TIER_REPLIES + 1) {
    return { tier, count, lastFlip: now, action: 'exhausted', replyTier: MAX_TIER };
  }
  return { tier, count, lastFlip: now, action: 'none', replyTier: MAX_TIER };
}

function isTableflip(content) {
  return content.includes(FLIPPED_TABLE);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function forgetGuild(guildId) {
  anger.delete(guildId);
}

async function handleTableflip(message, store) {
  if (message.author?.bot || message.system || !message.guildId) return;
  // Cheap substring gate so the store is only touched on an actual flip.
  if (!isTableflip(message.content)) return;

  // Flipping in the trap channel is a ban, not a bit, so leave it to the honeypot.
  // Fail closed: if the lookup errors we can't confirm this isn't the trap channel.
  let config;
  try {
    config = await store.getGuild(message.guildId);
  } catch (_) {
    return;
  }
  if (config && message.channelId === config.honeypotChannelId) return;
  if (config && config.tableflipEnabled === false) return;

  const state = nextState(anger.get(message.guildId), Date.now());
  anger.set(message.guildId, state);
  if (state.action === 'none') return;
  if (state.action === 'exhausted') {
    await message.channel.send(EXHAUSTED).catch(() => {});
    return;
  }

  const nsfw = message.channel?.nsfw === true || message.channel?.parent?.nsfw === true;
  const table = nsfw ? UNFLIP_NSFW : UNFLIP_SFW;
  await message.channel.send(pick(table[state.replyTier])).catch(() => {});
}

module.exports = {
  FLIPPED_TABLE,
  ANGER_RESET_MS,
  MAX_TIER,
  MAX_TIER_REPLIES,
  ADVANCE_AFTER,
  EXHAUSTED,
  UNFLIP_SFW,
  UNFLIP_NSFW,
  isTableflip,
  nextState,
  forgetGuild,
  handleTableflip,
};
