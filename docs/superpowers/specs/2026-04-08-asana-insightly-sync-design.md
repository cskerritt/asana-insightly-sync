# Asana → Insightly Sync Tool

## Overview

One-way sync tool that automatically copies projects, tasks, and opportunities from Asana into Insightly on a configurable schedule (default: 15 minutes). Can also be triggered manually.

## Data Mapping

### Asana Projects → Insightly Projects
| Asana Field | Insightly Field |
|---|---|
| name | PROJECT_NAME |
| notes | DESCRIPTION |
| current_status | STATUS |
| created_at | DATE_CREATED_UTC |
| due_on | DATE_DUE |

### Asana Tasks → Insightly Tasks
| Asana Field | Insightly Field |
|---|---|
| name | TITLE |
| notes | DETAILS |
| completed | STATUS (COMPLETED / NOT STARTED / IN PROGRESS) |
| due_on | DUE_DATE |
| assignee | RESPONSIBLE_USER_ID (best-effort match) |

### Asana Tasks → Insightly Opportunities
| Asana Field | Insightly Field |
|---|---|
| name | OPPORTUNITY_NAME |
| notes | DESCRIPTION |
| due_on | CLOSE_DATE |
| completed | STATE (WON / OPEN) |

All Asana tasks sync as both Insightly tasks and Insightly opportunities.

## Architecture

```
SkyviaApp/
├── .env                  # API keys (gitignored)
├── package.json
├── server.js             # Express server + cron scheduler
├── src/
│   ├── asana.js          # Asana API client
│   ├── insightly.js      # Insightly API client
│   ├── sync.js           # Sync orchestration logic
│   ├── db.js             # SQLite for ID mappings + sync history
│   └── logger.js         # Simple logger
├── public/
│   └── index.html        # Simple dashboard (sync status, history, manual trigger)
└── data/
    └── sync.db           # SQLite database (gitignored)
```

## Sync Logic

1. Fetch all projects from Asana
2. For each project, check ID mapping table
   - If new: create in Insightly, store mapping
   - If existing: update in Insightly
3. Fetch all tasks from Asana
4. For each task:
   - Create/update as Insightly task
   - Create/update as Insightly opportunity
   - Store ID mappings
5. Log sync run results (created, updated, failed counts)

### Incremental Sync
- Track `modified_at` timestamps
- On each run, only process items modified since last successful sync
- Full sync available via manual trigger with `?full=true`

## API Endpoints

- `GET /` — Dashboard
- `POST /sync` — Trigger manual sync
- `POST /sync?full=true` — Trigger full (non-incremental) sync
- `GET /api/status` — Current sync status (running/idle, last run time)
- `GET /api/history` — Last 50 sync runs with stats

## Schedule

- Default: every 15 minutes via node-cron
- Configurable via `SYNC_INTERVAL` env var (cron expression)

## Tech Stack

- Node.js + Express
- better-sqlite3
- node-cron
- axios
- dotenv

## Error Handling

- Individual item failures don't stop the sync — logged and skipped
- API rate limits: basic retry with backoff
- Failed syncs logged with error details in history
