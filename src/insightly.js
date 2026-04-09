const axios = require('axios');
const log = require('./logger');

const BASE_URL = 'https://api.insightly.com/v3.1';

let client;

function init(apiKey) {
  client = axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      'Content-Type': 'application/json',
    },
  });
}

// --- Projects ---

async function createProject(data) {
  const res = await client.post('/Projects', {
    PROJECT_NAME: data.name,
    PROJECT_DETAILS: data.description || '',
    STATUS: data.status || 'NOT STARTED',
  });
  return res.data;
}

async function updateProject(id, data) {
  const res = await client.put(`/Projects`, {
    PROJECT_ID: id,
    PROJECT_NAME: data.name,
    PROJECT_DETAILS: data.description || '',
    STATUS: data.status || 'NOT STARTED',
  });
  return res.data;
}

// --- Tasks ---

async function createTask(data) {
  const body = {
    TITLE: data.title,
    DETAILS: data.details || '',
    STATUS: data.status || 'NOT STARTED',
    DUE_DATE: data.dueDate || null,
  };
  if (data.projectId) {
    body.PROJECT_ID = data.projectId;
  }
  const res = await client.post('/Tasks', body);
  return res.data;
}

async function updateTask(id, data) {
  const body = {
    TASK_ID: id,
    TITLE: data.title,
    DETAILS: data.details || '',
    STATUS: data.status || 'NOT STARTED',
    DUE_DATE: data.dueDate || null,
  };
  if (data.projectId) {
    body.PROJECT_ID = data.projectId;
  }
  const res = await client.put(`/Tasks`, body);
  return res.data;
}

// --- Opportunities ---
// Default pipeline: Vocational Evaluation (296694), Stage 1: Records Obtained (952496)
const DEFAULT_PIPELINE_ID = 296694;
const DEFAULT_STAGE_ID = 952496;

async function createOpportunity(data) {
  const body = {
    OPPORTUNITY_NAME: data.name,
    OPPORTUNITY_DETAILS: data.description || '',
    OPPORTUNITY_STATE: data.state || 'OPEN',
    FORECAST_CLOSE_DATE: data.closeDate || null,
    PIPELINE_ID: data.pipelineId || DEFAULT_PIPELINE_ID,
    STAGE_ID: data.stageId || DEFAULT_STAGE_ID,
  };
  const res = await client.post('/Opportunities', body);
  return res.data;
}

async function updateOpportunity(id, data) {
  const body = {
    OPPORTUNITY_ID: id,
    OPPORTUNITY_NAME: data.name,
    OPPORTUNITY_DETAILS: data.description || '',
    OPPORTUNITY_STATE: data.state || 'OPEN',
    FORECAST_CLOSE_DATE: data.closeDate || null,
    PIPELINE_ID: data.pipelineId || DEFAULT_PIPELINE_ID,
    STAGE_ID: data.stageId || DEFAULT_STAGE_ID,
  };
  const res = await client.put(`/Opportunities`, body);
  return res.data;
}

// --- Organizations ---

async function searchOrganizations(name) {
  const res = await client.get('/Organisations', {
    params: { brief: true, top: 5, field_name: 'ORGANISATION_NAME', field_value: name },
  });
  return res.data;
}

async function createOrganization(data) {
  const res = await client.post('/Organisations', {
    ORGANISATION_NAME: data.name,
    PHONE: data.phone || null,
  });
  return res.data;
}

async function updateOrganization(id, data) {
  const res = await client.put('/Organisations', {
    ORGANISATION_ID: id,
    ORGANISATION_NAME: data.name,
    PHONE: data.phone || null,
  });
  return res.data;
}

// --- Contacts ---

async function searchContacts(firstName, lastName) {
  const res = await client.get('/Contacts', {
    params: { brief: true, top: 5, field_name: 'LAST_NAME', field_value: lastName },
  });
  // Filter by first name too
  return res.data.filter(c =>
    c.FIRST_NAME && c.FIRST_NAME.toLowerCase().includes(firstName.toLowerCase())
  );
}

async function createContact(data) {
  const body = {
    FIRST_NAME: data.firstName,
    LAST_NAME: data.lastName,
    EMAIL_ADDRESS: data.email || null,
    PHONE: data.phone || null,
  };
  if (data.organizationId) {
    body.ORGANISATION_ID = data.organizationId;
  }
  const res = await client.post('/Contacts', body);
  return res.data;
}

async function updateContact(id, data) {
  const body = {
    CONTACT_ID: id,
    FIRST_NAME: data.firstName,
    LAST_NAME: data.lastName,
    EMAIL_ADDRESS: data.email || null,
    PHONE: data.phone || null,
  };
  if (data.organizationId) {
    body.ORGANISATION_ID = data.organizationId;
  }
  const res = await client.put('/Contacts', body);
  return res.data;
}

// --- Links ---

async function linkContactToOpportunity(opportunityId, contactId) {
  try {
    await client.post(`/Opportunities/${opportunityId}/Links`, {
      LINK_OBJECT_NAME: 'Contact',
      LINK_OBJECT_ID: contactId,
    });
  } catch (err) {
    // Link may already exist, ignore 400s
    if (!err.response || err.response.status !== 400) throw err;
  }
}

// --- Notes ---

async function addNote(objectType, objectId, title, body) {
  try {
    await client.post(`/${objectType}/${objectId}/Notes`, {
      TITLE: title,
      BODY: body,
    });
  } catch (err) {
    if (!err.response || err.response.status !== 400) throw err;
  }
}

// --- Tags ---

async function addTagToContact(contactId, tagName) {
  try {
    await client.post(`/Contacts/${contactId}/Tags`, { TAG_NAME: tagName });
  } catch (err) {
    // Tag may already exist
    if (!err.response || err.response.status !== 400) throw err;
  }
}

module.exports = {
  init,
  createProject, updateProject,
  createTask, updateTask,
  createOpportunity, updateOpportunity,
  searchOrganizations, createOrganization, updateOrganization,
  searchContacts, createContact, updateContact,
  linkContactToOpportunity,
  addNote, addTagToContact,
};
