const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

let db;

function init() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'sync.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS id_mappings (
      asana_type TEXT NOT NULL,
      asana_id TEXT NOT NULL,
      insightly_type TEXT NOT NULL,
      insightly_id INTEGER NOT NULL,
      last_synced TEXT NOT NULL,
      PRIMARY KEY (asana_type, asana_id, insightly_type)
    );

    CREATE TABLE IF NOT EXISTS sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT DEFAULT 'running',
      projects_created INTEGER DEFAULT 0,
      projects_updated INTEGER DEFAULT 0,
      tasks_created INTEGER DEFAULT 0,
      tasks_updated INTEGER DEFAULT 0,
      opportunities_created INTEGER DEFAULT 0,
      opportunities_updated INTEGER DEFAULT 0,
      contacts_created INTEGER DEFAULT 0,
      contacts_updated INTEGER DEFAULT 0,
      orgs_created INTEGER DEFAULT 0,
      orgs_updated INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      error_details TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  log.info('Database initialized');
}

// --- ID Mappings ---

function getMapping(asanaType, asanaId, insightlyType) {
  return db.prepare(
    'SELECT * FROM id_mappings WHERE asana_type = ? AND asana_id = ? AND insightly_type = ?'
  ).get(asanaType, asanaId, insightlyType);
}

function setMapping(asanaType, asanaId, insightlyType, insightlyId) {
  db.prepare(`
    INSERT INTO id_mappings (asana_type, asana_id, insightly_type, insightly_id, last_synced)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(asana_type, asana_id, insightly_type) DO UPDATE SET
      insightly_id = excluded.insightly_id,
      last_synced = excluded.last_synced
  `).run(asanaType, asanaId, insightlyType, insightlyId, new Date().toISOString());
}

// --- Sync History ---

function startSyncRun() {
  const result = db.prepare(
    'INSERT INTO sync_history (started_at) VALUES (?)'
  ).run(new Date().toISOString());
  return result.lastInsertRowid;
}

function finishSyncRun(runId, stats) {
  db.prepare(`
    UPDATE sync_history SET
      finished_at = ?,
      status = ?,
      projects_created = ?,
      projects_updated = ?,
      tasks_created = ?,
      tasks_updated = ?,
      opportunities_created = ?,
      opportunities_updated = ?,
      contacts_created = ?,
      contacts_updated = ?,
      orgs_created = ?,
      orgs_updated = ?,
      errors = ?,
      error_details = ?
    WHERE id = ?
  `).run(
    new Date().toISOString(),
    stats.status || 'completed',
    stats.projectsCreated || 0,
    stats.projectsUpdated || 0,
    stats.tasksCreated || 0,
    stats.tasksUpdated || 0,
    stats.opportunitiesCreated || 0,
    stats.opportunitiesUpdated || 0,
    stats.contactsCreated || 0,
    stats.contactsUpdated || 0,
    stats.orgsCreated || 0,
    stats.orgsUpdated || 0,
    stats.errors || 0,
    stats.errorDetails || null,
    runId
  );
}

function getHistory(limit = 50) {
  return db.prepare(
    'SELECT * FROM sync_history ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

function getLatestRun() {
  return db.prepare(
    'SELECT * FROM sync_history ORDER BY id DESC LIMIT 1'
  ).get();
}

// --- Sync State ---

function getState(key) {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = {
  init, getMapping, setMapping,
  startSyncRun, finishSyncRun, getHistory, getLatestRun,
  getState, setState,
};
