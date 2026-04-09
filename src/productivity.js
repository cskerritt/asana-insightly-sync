const axios = require('axios');
const log = require('./logger');

const BASE_URL = 'https://app.asana.com/api/1.0';
let client;

function init(token) {
  client = axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function fetchAllTasks(assigneeGid, workspaceGid) {
  const tasks = [];
  let url = '/tasks';
  let params = {
    assignee: assigneeGid,
    workspace: workspaceGid,
    opt_fields: 'name,completed,completed_at,created_at,due_on,modified_at,projects.name',
    limit: 100,
  };
  while (url) {
    const res = await client.get(url, { params });
    tasks.push(...res.data.data);
    url = res.data.next_page ? res.data.next_page.path : null;
    params = {};
  }
  return tasks;
}

async function generate() {
  if (!client) throw new Error('Productivity module not initialized');

  log.info('Generating productivity report...');

  // Get workspaces
  const wsRes = await client.get('/workspaces');
  const workspaces = wsRes.data.data;

  const teamData = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 86400000);
  const sixtyDaysAgo = new Date(now - 60 * 86400000);
  const ninetyDaysAgo = new Date(now - 90 * 86400000);

  for (const ws of workspaces) {
    const usersRes = await client.get('/users', {
      params: { workspace: ws.gid, opt_fields: 'name,email' },
    });

    for (const user of usersRes.data.data) {
      try {
        const tasks = await fetchAllTasks(user.gid, ws.gid);
        if (tasks.length < 3) continue; // Skip users with barely any tasks

        const completed = tasks.filter(t => t.completed);
        const open = tasks.filter(t => !t.completed);
        const overdue = open.filter(t => t.due_on && new Date(t.due_on) < now);
        const dueSoon = open.filter(t => {
          if (!t.due_on) return false;
          const due = new Date(t.due_on);
          const daysUntil = (due - now) / 86400000;
          return daysUntil >= 0 && daysUntil <= 7;
        });

        // Completion times
        const completionDays = [];
        completed.forEach(t => {
          if (t.created_at && t.completed_at) {
            completionDays.push((new Date(t.completed_at) - new Date(t.created_at)) / 86400000);
          }
        });
        const avgDays = completionDays.length
          ? Math.round(completionDays.reduce((a, b) => a + b, 0) / completionDays.length)
          : 0;
        const medianDays = completionDays.length
          ? Math.round(completionDays.sort((a, b) => a - b)[Math.floor(completionDays.length / 2)])
          : 0;

        // Recent activity
        const completed30 = completed.filter(t => new Date(t.completed_at) > thirtyDaysAgo).length;
        const completed60 = completed.filter(t => new Date(t.completed_at) > sixtyDaysAgo).length;
        const completed90 = completed.filter(t => new Date(t.completed_at) > ninetyDaysAgo).length;

        // Monthly trend (last 6 months)
        const monthlyCompleted = {};
        completed.forEach(t => {
          if (t.completed_at) {
            const d = new Date(t.completed_at);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            monthlyCompleted[key] = (monthlyCompleted[key] || 0) + 1;
          }
        });

        // Projects breakdown
        const byProject = {};
        tasks.forEach(t => {
          const proj = t.projects && t.projects.length ? t.projects[0].name : 'Unassigned';
          if (!byProject[proj]) byProject[proj] = { total: 0, completed: 0, open: 0 };
          byProject[proj].total++;
          if (t.completed) byProject[proj].completed++;
          else byProject[proj].open++;
        });

        // Overdue details
        const overdueList = overdue
          .map(t => ({
            name: t.name,
            dueOn: t.due_on,
            daysOverdue: Math.round((now - new Date(t.due_on)) / 86400000),
          }))
          .sort((a, b) => b.daysOverdue - a.daysOverdue);

        // Completion rate
        const completionRate = tasks.length > 0 ? Math.round(completed.length / tasks.length * 100) : 0;

        // Flag concerns
        const concerns = [];
        if (overdue.length >= 3) concerns.push(`${overdue.length} overdue tasks`);
        if (completed30 === 0 && open.length > 0) concerns.push('No completions in 30 days');
        if (avgDays > 120) concerns.push(`Avg ${avgDays} days to complete`);
        if (completionRate < 50 && tasks.length > 10) concerns.push(`${completionRate}% completion rate`);
        const unassignedPct = byProject['Unassigned'] ? Math.round(byProject['Unassigned'].total / tasks.length * 100) : 0;
        if (unassignedPct > 80 && tasks.length > 10) concerns.push(`${unassignedPct}% tasks not in projects`);

        teamData.push({
          name: user.name,
          email: user.email || '',
          workspace: ws.name,
          total: tasks.length,
          completed: completed.length,
          open: open.length,
          overdue: overdue.length,
          dueSoon: dueSoon.length,
          avgDays,
          medianDays,
          completionRate,
          completed30,
          completed60,
          completed90,
          monthlyCompleted,
          byProject,
          overdueList: overdueList.slice(0, 10),
          concerns,
          hasConcerns: concerns.length > 0,
        });
      } catch (err) {
        // Skip users we can't fetch
      }
    }
  }

  // Sort by total tasks descending
  teamData.sort((a, b) => b.total - a.total);

  // Team averages (only for people with 20+ tasks)
  const significantMembers = teamData.filter(m => m.total >= 20);
  const teamAvgDays = significantMembers.length
    ? Math.round(significantMembers.reduce((s, m) => s + m.avgDays, 0) / significantMembers.length)
    : 0;
  const teamAvgCompletion = significantMembers.length
    ? Math.round(significantMembers.reduce((s, m) => s + m.completionRate, 0) / significantMembers.length)
    : 0;
  const totalOverdue = teamData.reduce((s, m) => s + m.overdue, 0);
  const totalOpen = teamData.reduce((s, m) => s + m.open, 0);

  log.info(`Productivity report generated — ${teamData.length} team members`);

  return {
    team: teamData,
    summary: {
      totalMembers: teamData.length,
      totalOpen,
      totalOverdue,
      teamAvgDays,
      teamAvgCompletion,
    },
  };
}

module.exports = { init, generate };
