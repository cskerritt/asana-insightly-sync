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

app.listen(PORT, () => {
  log.info(`Server running at http://localhost:${PORT}`);
});
