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
    opt_fields: 'name,completed,completed_at,created_at,due_on,modified_at,projects.name,custom_fields.name,custom_fields.display_value,custom_fields.type,custom_fields.number_value,custom_fields.enum_value.name,custom_fields.people_value.name',
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
        if (tasks.length === 0) continue; // Skip users with no tasks

        // Extract custom fields
        function getCF(task, fieldName) {
          if (!task.custom_fields) return null;
          const f = task.custom_fields.find(cf => cf.name === fieldName);
          if (!f) return null;
          if (f.enum_value) return f.enum_value.name;
          if (f.display_value) return f.display_value;
          if (f.number_value !== null && f.number_value !== undefined) return f.number_value;
          if (f.people_value && f.people_value.length) return f.people_value.map(p => p.name).join(', ');
          return null;
        }

        const completed = tasks.filter(t => t.completed);
        const open = tasks.filter(t => !t.completed);
        const overdue = open.filter(t => t.due_on && new Date(t.due_on) < now);

        // Priority breakdown
        const byPriority = { High: 0, Medium: 0, Low: 0, None: 0 };
        open.forEach(t => {
          const p = getCF(t, 'Priority') || 'None';
          byPriority[p] = (byPriority[p] || 0) + 1;
        });
        const highPriorityOverdue = overdue.filter(t => getCF(t, 'Priority') === 'High').length;

        // Estimated vs actual time
        let totalEstimated = 0, totalActual = 0, estimateCount = 0;
        completed.forEach(t => {
          const est = getCF(t, 'Estimated time');
          if (est && t.created_at && t.completed_at) {
            const actual = (new Date(t.completed_at) - new Date(t.created_at)) / 86400000;
            totalEstimated += est;
            totalActual += actual;
            estimateCount++;
          }
        });
        const estimateAccuracy = estimateCount > 0
          ? Math.round(totalEstimated / totalActual * 100)
          : null;

        // Percent allocation
        const allocation = open.reduce((sum, t) => {
          const pct = getCF(t, 'Percent allocation');
          return sum + (pct || 0);
        }, 0);
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
            priority: getCF(t, 'Priority') || 'None',
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
        if (highPriorityOverdue > 0) concerns.push(`${highPriorityOverdue} HIGH priority overdue`);

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
          // Custom field data
          byPriority,
          highPriorityOverdue,
          allocation,
          estimateAccuracy,
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
