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

    CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      attorney_name TEXT,
      firm TEXT,
      email TEXT,
      description TEXT,
      completed INTEGER DEFAULT 0,
      completed_at TEXT,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attorneys (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      firm_name TEXT DEFAULT '',
      firm_address TEXT,
      state TEXT NOT NULL,
      practice_areas TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      insightly_contact_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_attorney_dedup
      ON attorneys(first_name, last_name, state, firm_name);

    CREATE TABLE IF NOT EXISTS attorney_search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      practice_area TEXT NOT NULL,
      source TEXT NOT NULL,
      searched_at TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_progress'
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

// --- Action Items ---

function getActionItems(category) {
  if (category) {
    return db.prepare('SELECT * FROM action_items WHERE category = ? ORDER BY completed ASC, created_at DESC').all(category);
  }
  return db.prepare('SELECT * FROM action_items ORDER BY completed ASC, created_at DESC').all();
}

function upsertActionItem(item) {
  db.prepare(`
    INSERT INTO action_items (id, category, attorney_name, firm, email, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category = excluded.category,
      attorney_name = excluded.attorney_name,
      firm = excluded.firm,
      email = excluded.email,
      description = excluded.description
  `).run(item.id, item.category, item.attorneyName, item.firm, item.email, item.description, new Date().toISOString());
}

function updateActionItem(id, updates) {
  if (updates.completed !== undefined) {
    db.prepare('UPDATE action_items SET completed = ?, completed_at = ? WHERE id = ?')
      .run(updates.completed ? 1 : 0, updates.completed ? new Date().toISOString() : null, id);
  }
  if (updates.notes !== undefined) {
    db.prepare('UPDATE action_items SET notes = ? WHERE id = ?').run(updates.notes, id);
  }
}

// --- Attorneys ---

function upsertAttorney(record) {
  const id = record.id || require('crypto').randomUUID();
  const existing = db.prepare(
    'SELECT * FROM attorneys WHERE first_name = ? AND last_name = ? AND state = ? AND firm_name = ?'
  ).get(record.firstName, record.lastName, record.state, record.firmName || '');

  if (existing) {
    const updates = {};
    if (record.email && !existing.email) updates.email = record.email;
    if (record.phone && !existing.phone) updates.phone = record.phone;
    if (record.firmAddress && !existing.firm_address) updates.firm_address = record.firmAddress;
    if (Object.keys(updates).length > 0) {
      const sets = Object.entries(updates).map(([k]) => `${k} = ?`).join(', ');
      const vals = Object.values(updates);
      db.prepare(`UPDATE attorneys SET ${sets} WHERE id = ?`).run(...vals, existing.id);
    }
    return { created: false, id: existing.id };
  }

  db.prepare(`
    INSERT INTO attorneys (id, first_name, last_name, email, phone, firm_name, firm_address, state, practice_areas, source, source_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, record.firstName, record.lastName, record.email || null, record.phone || null,
    record.firmName || '', record.firmAddress || null, record.state,
    JSON.stringify(record.practiceAreas || []), record.source, record.sourceUrl || '',
    new Date().toISOString()
  );
  return { created: true, id };
}

function getAttorneys(filters = {}) {
  let sql = 'SELECT * FROM attorneys WHERE 1=1';
  const params = [];
  if (filters.state) { sql += ' AND state = ?'; params.push(filters.state); }
  if (filters.practiceArea) { sql += ' AND practice_areas LIKE ?'; params.push(`%${filters.practiceArea}%`); }
  sql += ' ORDER BY last_name, first_name';
  return db.prepare(sql).all(...params);
}

function getAttorneyById(id) {
  return db.prepare('SELECT * FROM attorneys WHERE id = ?').get(id);
}

function setAttorneyInsightlyId(id, contactId) {
  db.prepare('UPDATE attorneys SET insightly_contact_id = ? WHERE id = ?').run(contactId, id);
}

function getAttorneyStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM attorneys').get().count;
  const pushed = db.prepare('SELECT COUNT(*) as count FROM attorneys WHERE insightly_contact_id IS NOT NULL').get().count;
  const statesCovered = db.prepare(
    "SELECT COUNT(DISTINCT state) as count FROM attorney_search_log WHERE status = 'completed'"
  ).get().count;
  return { total, pushed, statesCovered };
}

function getCoverageGrid() {
  return db.prepare(
    "SELECT state, practice_area, result_count, searched_at FROM attorney_search_log WHERE status = 'completed' ORDER BY searched_at DESC"
  ).all();
}

function getSearchLog() {
  return db.prepare('SELECT * FROM attorney_search_log ORDER BY searched_at DESC').all();
}

function hasSearched(state, practiceArea, source) {
  return db.prepare(
    "SELECT * FROM attorney_search_log WHERE state = ? AND practice_area = ? AND source = ? AND status = 'completed' ORDER BY searched_at DESC LIMIT 1"
  ).get(state, practiceArea, source) || null;
}

function createSearchLog(state, practiceArea, source) {
  const result = db.prepare(
    'INSERT INTO attorney_search_log (state, practice_area, source, searched_at) VALUES (?, ?, ?, ?)'
  ).run(state, practiceArea, source, new Date().toISOString());
  return result.lastInsertRowid;
}

function updateSearchLog(id, status, resultCount) {
  db.prepare(
    'UPDATE attorney_search_log SET status = ?, result_count = ? WHERE id = ?'
  ).run(status, resultCount, id);
}

module.exports = {
  init, getMapping, setMapping,
  startSyncRun, finishSyncRun, getHistory, getLatestRun,
  getState, setState,
  getActionItems, upsertActionItem, updateActionItem,
  // Attorneys
  upsertAttorney, getAttorneys, getAttorneyById, setAttorneyInsightlyId,
  getAttorneyStats, getCoverageGrid, getSearchLog,
  hasSearched, createSearchLog, updateSearchLog,
};
