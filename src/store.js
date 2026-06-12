'use strict';

// Choose the backend at startup. DATABASE_URL (set by the Heroku Postgres
// add-on, or any managed Postgres) selects Postgres so config persists on hosts
// with an ephemeral filesystem; otherwise the local SQLite file is used. Both
// backends expose the same async interface: init, getGuild, setHoneypot,
// setAnchor, close.
module.exports = process.env.DATABASE_URL
  ? require('./stores/postgres')
  : require('./stores/sqlite');
