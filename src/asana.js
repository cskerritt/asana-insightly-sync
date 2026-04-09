const axios = require('axios');
const log = require('./logger');

const BASE_URL = 'https://app.asana.com/api/1.0';

function createClient(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

let client;

function init(token) {
  client = createClient(token);
}

async function getWorkspaces() {
  const res = await client.get('/workspaces');
  return res.data.data;
}

async function getProjects(workspaceGid, modifiedSince) {
  const params = { workspace: workspaceGid, opt_fields: 'name,notes,current_status,created_at,due_on,modified_at' };
  if (modifiedSince) {
    params.modified_since = modifiedSince;
  }
  const projects = [];
  let url = '/projects';
  while (url) {
    const res = await client.get(url, { params });
    projects.push(...res.data.data);
    url = res.data.next_page ? res.data.next_page.path : null;
    params.offset = undefined; // pagination handled by next_page path
  }
  return projects;
}

async function getProject(projectGid) {
  const res = await client.get(`/projects/${projectGid}`, {
    params: { opt_fields: 'name,notes,current_status,created_at,due_on,modified_at,color' },
  });
  return res.data.data;
}

async function getTasks(projectGid, modifiedSince) {
  const params = {
    project: projectGid,
    opt_fields: 'name,notes,completed,due_on,assignee,assignee.name,assignee.email,modified_at,created_at',
  };
  if (modifiedSince) {
    params.modified_since = modifiedSince;
  }
  const tasks = [];
  let url = '/tasks';
  while (url) {
    const res = await client.get(url, { params });
    tasks.push(...res.data.data);
    url = res.data.next_page ? res.data.next_page.path : null;
  }
  return tasks;
}

async function getTask(taskGid) {
  const res = await client.get(`/tasks/${taskGid}`, {
    params: { opt_fields: 'name,notes,completed,due_on,assignee,assignee.name,assignee.email,modified_at,created_at' },
  });
  return res.data.data;
}

module.exports = { init, getWorkspaces, getProjects, getProject, getTasks, getTask };
