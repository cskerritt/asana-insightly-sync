const asana = require('./asana');
const insightly = require('./insightly');
const db = require('./db');
const log = require('./logger');
const { parseNotes } = require('./parser');

let running = false;

function isRunning() {
  return running;
}

function mapAsanaStatus(completed) {
  return completed ? 'COMPLETED' : 'NOT STARTED';
}

function mapOpportunityState(completed) {
  return completed ? 'WON' : 'OPEN';
}

function splitName(fullName) {
  if (!fullName) return { firstName: '', lastName: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function run(full = false) {
  if (running) {
    log.warn('Sync already in progress, skipping');
    return null;
  }

  running = true;
  const runId = db.startSyncRun();
  const stats = {
    projectsCreated: 0,
    projectsUpdated: 0,
    tasksCreated: 0,
    tasksUpdated: 0,
    opportunitiesCreated: 0,
    opportunitiesUpdated: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    orgsCreated: 0,
    orgsUpdated: 0,
    errors: 0,
    errorDetails: [],
  };

  const lastSync = full ? null : db.getState('last_successful_sync');

  try {
    log.info(`Starting ${full ? 'full' : 'incremental'} sync...`);

    const workspaces = await asana.getWorkspaces();
    if (!workspaces.length) {
      throw new Error('No Asana workspaces found');
    }

    for (const workspace of workspaces) {
      log.info(`Syncing workspace: ${workspace.name}`);

      // Sync projects
      const projects = await asana.getProjects(workspace.gid, lastSync);
      for (const projectSummary of projects) {
        try {
          const project = await asana.getProject(projectSummary.gid);
          await syncProject(project, stats);
        } catch (err) {
          stats.errors++;
          stats.errorDetails.push(`Project ${projectSummary.gid}: ${err.message}`);
          log.error(`Failed to sync project ${projectSummary.name}`, err.message);
        }
      }

      // Sync tasks per project
      for (const projectSummary of projects) {
        try {
          const mapping = db.getMapping('project', projectSummary.gid, 'project');
          const insightlyProjectId = mapping ? mapping.insightly_id : null;
          const tasks = await asana.getTasks(projectSummary.gid, lastSync);

          for (const task of tasks) {
            // Parse referring attorney info from notes
            const parsed = parseNotes(task.notes);

            // Sync organization (law firm)
            let orgId = null;
            if (parsed && parsed.firmName) {
              try {
                orgId = await syncOrganization(parsed, stats);
              } catch (err) {
                const detail = err.response ? JSON.stringify(err.response.data) : err.message;
                stats.errors++;
                stats.errorDetails.push(`Org for task ${task.gid}: ${detail}`);
                log.error(`Failed to sync org ${parsed.firmName}`, detail);
              }
            }

            // Sync contact (referring attorney)
            let contactId = null;
            if (parsed && parsed.attorneyName) {
              try {
                contactId = await syncContact(parsed, orgId, stats);
              } catch (err) {
                const detail = err.response ? JSON.stringify(err.response.data) : err.message;
                stats.errors++;
                stats.errorDetails.push(`Contact for task ${task.gid}: ${detail}`);
                log.error(`Failed to sync contact ${parsed.attorneyName}`, detail);
              }
            }

            // Sync task
            try {
              await syncTask(task, insightlyProjectId, stats);
            } catch (err) {
              stats.errors++;
              stats.errorDetails.push(`Task ${task.gid}: ${err.message}`);
              log.error(`Failed to sync task ${task.name}`, err.message);
            }

            // Sync opportunity and link contact
            try {
              const oppId = await syncOpportunity(task, stats);
              if (contactId && oppId) {
                await insightly.linkContactToOpportunity(oppId, contactId);
                log.info(`Linked ${parsed.attorneyName} to opportunity ${task.name}`);
              }
            } catch (err) {
              const detail = err.response ? JSON.stringify(err.response.data) : err.message;
              stats.errors++;
              stats.errorDetails.push(`Opportunity from task ${task.gid}: ${detail}`);
              log.error(`Failed to sync opportunity for task ${task.name}`, detail);
            }
          }
        } catch (err) {
          stats.errors++;
          stats.errorDetails.push(`Tasks for project ${projectSummary.gid}: ${err.message}`);
          log.error(`Failed to fetch tasks for project ${projectSummary.name}`, err.message);
        }
      }
    }

    db.setState('last_successful_sync', new Date().toISOString());
    stats.status = 'completed';
    log.info('Sync completed', stats);
  } catch (err) {
    stats.status = 'failed';
    stats.errors++;
    stats.errorDetails.push(`Fatal: ${err.message}`);
    log.error('Sync failed', err.message);
  } finally {
    stats.errorDetails = stats.errorDetails.length ? stats.errorDetails.join('\n') : null;
    db.finishSyncRun(runId, stats);
    running = false;
  }

  return stats;
}

async function syncProject(project, stats) {
  const existing = db.getMapping('project', project.gid, 'project');

  const data = {
    name: project.name,
    description: project.notes || '',
    status: project.current_status ? project.current_status.text : 'NOT STARTED',
  };

  if (existing) {
    await insightly.updateProject(existing.insightly_id, data);
    db.setMapping('project', project.gid, 'project', existing.insightly_id);
    stats.projectsUpdated++;
    log.info(`Updated project: ${project.name}`);
  } else {
    const created = await insightly.createProject(data);
    db.setMapping('project', project.gid, 'project', created.PROJECT_ID);
    stats.projectsCreated++;
    log.info(`Created project: ${project.name}`);
  }
}

async function syncOrganization(parsed, stats) {
  const firmName = parsed.firmName;
  // Check local mapping first (using firm name as key)
  const existingMapping = db.getMapping('org', firmName, 'organization');
  if (existingMapping) {
    return existingMapping.insightly_id;
  }

  // Search Insightly for existing org
  const existing = await insightly.searchOrganizations(firmName);
  if (existing.length > 0) {
    db.setMapping('org', firmName, 'organization', existing[0].ORGANISATION_ID);
    stats.orgsUpdated++;
    log.info(`Found existing org: ${firmName}`);
    return existing[0].ORGANISATION_ID;
  }

  // Create new
  const created = await insightly.createOrganization({ name: firmName });
  db.setMapping('org', firmName, 'organization', created.ORGANISATION_ID);
  stats.orgsCreated++;
  log.info(`Created org: ${firmName}`);
  return created.ORGANISATION_ID;
}

async function syncContact(parsed, orgId, stats) {
  const { firstName, lastName } = splitName(parsed.attorneyName);
  if (!lastName && !firstName) return null;

  // Check local mapping (using attorney name as key)
  const contactKey = `${firstName}|${lastName}`.toLowerCase();
  const existingMapping = db.getMapping('contact', contactKey, 'contact');
  if (existingMapping) {
    return existingMapping.insightly_id;
  }

  // Search Insightly
  if (lastName) {
    const existing = await insightly.searchContacts(firstName, lastName);
    if (existing.length > 0) {
      db.setMapping('contact', contactKey, 'contact', existing[0].CONTACT_ID);
      stats.contactsUpdated++;
      log.info(`Found existing contact: ${parsed.attorneyName}`);
      return existing[0].CONTACT_ID;
    }
  }

  // Create new
  const created = await insightly.createContact({
    firstName,
    lastName,
    email: parsed.email,
    phone: parsed.phone,
    organizationId: orgId,
  });
  db.setMapping('contact', contactKey, 'contact', created.CONTACT_ID);
  stats.contactsCreated++;
  log.info(`Created contact: ${parsed.attorneyName} (${parsed.firmName || 'no firm'})`);
  return created.CONTACT_ID;
}

async function syncTask(task, insightlyProjectId, stats) {
  const existing = db.getMapping('task', task.gid, 'task');

  const data = {
    title: task.name,
    details: task.notes || '',
    status: mapAsanaStatus(task.completed),
    dueDate: task.due_on || null,
    projectId: insightlyProjectId,
  };

  if (existing) {
    await insightly.updateTask(existing.insightly_id, data);
    db.setMapping('task', task.gid, 'task', existing.insightly_id);
    stats.tasksUpdated++;
    log.info(`Updated task: ${task.name}`);
  } else {
    const created = await insightly.createTask(data);
    db.setMapping('task', task.gid, 'task', created.TASK_ID);
    stats.tasksCreated++;
    log.info(`Created task: ${task.name}`);
  }
}

async function syncOpportunity(task, stats) {
  const existing = db.getMapping('task', task.gid, 'opportunity');

  const data = {
    name: task.name,
    description: task.notes || '',
    state: mapOpportunityState(task.completed),
    closeDate: task.due_on || null,
  };

  if (existing) {
    await insightly.updateOpportunity(existing.insightly_id, data);
    db.setMapping('task', task.gid, 'opportunity', existing.insightly_id);
    stats.opportunitiesUpdated++;
    log.info(`Updated opportunity: ${task.name}`);
    return existing.insightly_id;
  } else {
    const created = await insightly.createOpportunity(data);
    db.setMapping('task', task.gid, 'opportunity', created.OPPORTUNITY_ID);
    stats.opportunitiesCreated++;
    log.info(`Created opportunity: ${task.name}`);
    return created.OPPORTUNITY_ID;
  }
}

module.exports = { run, isRunning };
