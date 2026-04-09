require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const asana = require('./src/asana');
const insightly = require('./src/insightly');
const db = require('./src/db');
const sync = require('./src/sync');
const log = require('./src/logger');

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
