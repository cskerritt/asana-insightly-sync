require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const asana = require('./src/asana');
const insightly = require('./src/insightly');
const db = require('./src/db');
const sync = require('./src/sync');
const log = require('./src/logger');
const attorneys = require('./src/attorneys');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize
db.init();
asana.init(process.env.ASANA_TOKEN);
insightly.init(process.env.INSIGHTLY_API_KEY);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API: trigger sync
app.post('/sync', async (req, res) => {
  if (sync.isRunning()) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }
  const full = req.query.full === 'true';
  // Run async, return immediately
  sync.run(full).catch(err => log.error('Sync error', err.message));
  res.json({ message: `${full ? 'Full' : 'Incremental'} sync started` });
});

// API: status
app.get('/api/status', (req, res) => {
  const latest = db.getLatestRun();
  res.json({
    running: sync.isRunning(),
    lastRun: latest || null,
    lastSuccessfulSync: db.getState('last_successful_sync'),
  });
});

// API: history
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.getHistory(limit));
});

// API: team productivity — fetches from Asana
const productivity = require('./src/productivity');
productivity.init(process.env.ASANA_TOKEN);

app.get('/api/productivity', async (req, res) => {
  try {
    const data = await productivity.generate();
    res.json(data);
  } catch (err) {
    log.error('Productivity report failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: report data — fetches from Insightly for reporting
const report = require('./src/report');
app.get('/api/report', async (req, res) => {
  try {
    const data = await report.generate();
    res.json(data);
  } catch (err) {
    log.error('Report generation failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Parse JSON bodies
app.use(express.json());

// API: action items
app.get('/api/actions', (req, res) => {
  const category = req.query.category || null;
  res.json(db.getActionItems(category));
});

app.put('/api/actions/:id', (req, res) => {
  db.updateActionItem(req.params.id, req.body);
  res.json({ ok: true });
});

app.post('/api/actions/sync', async (req, res) => {
  try {
    const data = await report.generate();
    // Sync marketing action items to DB
    const categories = [
      { key: 'vip', list: data.vipReferrers, desc: 'VIP — schedule quarterly check-in, send case updates, ask for referrals to colleagues' },
      { key: 'cold', list: data.coldAttorneys, desc: 'Re-engage — personal call or email to reconnect' },
      { key: 'slowing', list: data.velocityAlerts || [], desc: 'Slowing down — used to refer regularly, pace has dropped' },
      { key: 'warm', list: data.warmingReferrers, desc: 'Growing — send thank-you, share article or CLE invite' },
      { key: 'new', list: data.newReferrers, desc: 'New — send thank-you within 48 hours, follow up after report delivery' },
      { key: 'crosssell', list: (data.crossSellOpps || []).map(c => ({ name: c.firm, firm: `Missing: ${c.missingServices.join(', ')}`, email: '', count: c.count })), desc: 'Cross-sell — this firm doesn\'t know about all our services' },
      { key: 'opposing', list: (data.opposingCounselLeads || []).filter(o => o.count >= 2).map(o => ({ name: o.name, firm: o.firm, email: '', count: o.count })), desc: 'Opposing counsel who\'ve seen our work — potential new referrers' },
    ];
    let count = 0;
    for (const cat of categories) {
      for (const a of cat.list) {
        db.upsertActionItem({
          id: `${cat.key}-${a.name}-${a.firm}`.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          category: cat.key,
          attorneyName: a.name,
          firm: a.firm,
          email: a.email || '',
          description: cat.desc,
        });
        count++;
      }
    }
    res.json({ synced: count });
  } catch (err) {
    log.error('Action sync failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Attorney Lead Finder ---

app.get('/api/attorneys', (req, res) => {
  const filters = {};
  if (req.query.state) filters.state = req.query.state;
  if (req.query.practice_area) filters.practiceArea = req.query.practice_area;
  res.json(db.getAttorneys(filters));
});

app.get('/api/attorneys/stats', (req, res) => {
  res.json(db.getAttorneyStats());
});

app.get('/api/attorneys/coverage', (req, res) => {
  res.json(db.getCoverageGrid());
});

app.get('/api/attorneys/search-log', (req, res) => {
  res.json(db.getSearchLog());
});

app.get('/api/attorneys/practice-areas', (req, res) => {
  res.json(attorneys.PRACTICE_AREAS);
});

app.get('/api/attorneys/states', (req, res) => {
  const states = Object.entries(attorneys.STATE_NAMES).map(([code, name]) => ({ code, name }));
  res.json(states);
});

app.post('/api/attorneys/search', async (req, res) => {
  const { state, practiceArea, forceRerun } = req.body;
  if (!state || !practiceArea) {
    return res.status(400).json({ error: 'state and practiceArea are required' });
  }

  if (!forceRerun) {
    const existing = db.hasSearched(state, practiceArea, 'avvo');
    if (existing) {
      return res.json({
        alreadySearched: true,
        searchedAt: existing.searched_at,
        resultCount: existing.result_count,
      });
    }
  }

  // Run async — return immediately, search in background
  const logId = db.createSearchLog(state, practiceArea, 'avvo');
  res.json({ message: 'Search started', logId });

  // Background execution (after response sent)
  try {
    log.info(`Starting attorney search: ${state} / ${practiceArea}`);
    const records = await attorneys.scrapeAvvo(state, practiceArea);
    let newCount = 0;
    for (const record of records) {
      const result = db.upsertAttorney(record);
      if (result.created) newCount++;
    }
    db.updateSearchLog(logId, 'completed', records.length);
    log.info(`Attorney search complete: ${records.length} found, ${newCount} new`);
  } catch (err) {
    log.error(`Attorney search failed: ${state} / ${practiceArea}`, err.message);
    db.updateSearchLog(logId, 'failed', 0);
  }
});

app.post('/api/attorneys/push', async (req, res) => {
  const { attorneyIds } = req.body;
  if (!attorneyIds || !attorneyIds.length) {
    return res.status(400).json({ error: 'attorneyIds required' });
  }
  try {
    const result = await attorneys.pushToInsightly(attorneyIds);
    res.json(result);
  } catch (err) {
    log.error('Attorney push to Insightly failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: case outcome tracking
app.post('/api/outcomes/:opportunityId', async (req, res) => {
  try {
    const { outcome, satisfaction, notes } = req.body;
    const title = `Case Outcome: ${outcome}${satisfaction ? ' (' + satisfaction + ')' : ''}`;
    await insightly.addNote('Opportunities', req.params.opportunityId, title, notes || '');
    res.json({ ok: true });
  } catch (err) {
    log.error('Outcome tracking failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Schedule sync
const interval = process.env.SYNC_INTERVAL || '*/15 * * * *';
if (cron.validate(interval)) {
  cron.schedule(interval, () => {
    log.info('Scheduled sync triggered');
    sync.run().catch(err => log.error('Scheduled sync error', err.message));
  });
  log.info(`Sync scheduled: ${interval}`);
} else {
  log.error(`Invalid cron expression: ${interval}`);
}

app.listen(PORT, '0.0.0.0', () => {
  log.info(`Server running on port ${PORT}`);
});
