const axios = require('axios');
const log = require('./logger');

const BASE_URL = 'https://api.insightly.com/v3.1';
let client;

function init() {
  const apiKey = process.env.INSIGHTLY_API_KEY;
  client = axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      'Content-Type': 'application/json',
    },
  });
}

async function fetchAll(endpoint, params = {}) {
  const results = [];
  let skip = 0;
  const top = 500;
  while (true) {
    const res = await client.get(endpoint, { params: { ...params, top, skip } });
    results.push(...res.data);
    if (res.data.length < top) break;
    skip += top;
  }
  return results;
}

// ============================================================
// Comprehensive case parser
// ============================================================
// Notes typically start with: "2026 PLT VE/LCP" or "2025 DEF VE" or "2026 MAT" or "2025 EMP"
// This gives us up to 3 dimensions:
//   - Side: PLT (Plaintiff) / DEF (Defense)
//   - Case area: MAT/MAR (Matrimonial), EMP (Employment), PI, WC, MVA, etc.
//   - Service type: VE, LCP, ECON, LHHS, CME, IME, ORS, etc.

const SIDE_LABELS = {
  PLT: 'Plaintiff',
  DEF: 'Defense',
};

const CASE_AREA_LABELS = {
  MAT: 'Matrimonial',
  MAR: 'Matrimonial',
  MARITAL: 'Matrimonial',
  MATT: 'Matrimonial',
  EMP: 'Employment',
  PI: 'Personal Injury',
  WC: "Workers' Comp",
  MVA: 'Motor Vehicle Accident',
  TRANSITION: 'Transition',
  MED: 'Medical',
  'WRONGFUL DEATH': 'Wrongful Death',
  ERISA: 'ERISA',
  DISCRIMINATION: 'Discrimination',
  MALPRACTICE: 'Malpractice',
  MAL: 'Malpractice',
  LTD: 'Long-Term Disability',
  TDIU: 'VA Disability (TDIU)',
  VA: 'VA',
  TBI: 'Traumatic Brain Injury',
};

const SERVICE_TYPE_LABELS = {
  VE: 'Vocational Evaluation',
  LCP: 'Life Care Plan',
  ECON: 'Economics',
  LHHS: 'Loss of Household Services',
  CME: 'Consulting Medical Exam',
  IME: 'Independent Medical Exam',
  ORS: 'ORS',
  RR: 'Records Review',
  REBUTTAL: 'Rebuttal',
  CRITIQUE: 'Critique',
  AFFIDAVIT: 'Affidavit',
};

function parseCase(details) {
  const result = {
    year: null,
    side: null,
    sideLabel: null,
    caseArea: null,
    caseAreaLabel: null,
    serviceTypes: [],
    serviceLabels: [],
    rawCode: null,
  };

  if (!details) return result;

  const firstLine = details.split('\n')[0].trim();

  // Extract year
  const yearMatch = firstLine.match(/^(\d{4})\s+/);
  if (!yearMatch) return result;
  result.year = parseInt(yearMatch[1]);

  // Get the code part after the year
  const codePart = firstLine.substring(yearMatch[0].length).trim();
  result.rawCode = codePart;

  // Tokenize: split on spaces and commas, but keep slash-separated items together
  const tokens = codePart.split(/[\s,]+/).filter(Boolean);

  for (const token of tokens) {
    const upper = token.toUpperCase().replace(/[^A-Z/]/g, '');

    // Check for side
    if (SIDE_LABELS[upper] && !result.side) {
      result.side = upper;
      result.sideLabel = SIDE_LABELS[upper];
      continue;
    }

    // Check for case area
    if (CASE_AREA_LABELS[upper] && !result.caseArea) {
      result.caseArea = upper;
      result.caseAreaLabel = CASE_AREA_LABELS[upper];
      continue;
    }

    // Check for service types (can be slash-separated like VE/LCP/ECON)
    const parts = upper.split('/');
    for (const part of parts) {
      if (SERVICE_TYPE_LABELS[part] && !result.serviceTypes.includes(part)) {
        result.serviceTypes.push(part);
        result.serviceLabels.push(SERVICE_TYPE_LABELS[part]);
      }
      // Also check if a service code is actually a case area we missed
      if (CASE_AREA_LABELS[part] && !result.caseArea) {
        result.caseArea = part;
        result.caseAreaLabel = CASE_AREA_LABELS[part];
      }
    }
  }

  // Check for "Wrongful Death" as a two-word phrase
  if (!result.caseArea && /wrongful\s*death/i.test(codePart)) {
    result.caseArea = 'WRONGFUL DEATH';
    result.caseAreaLabel = 'Wrongful Death';
  }

  // If we have a side (PLT/DEF) but no case area, it's likely PI (personal injury default)
  // If we have service types but no case area, derive from context
  if (!result.caseArea && result.side) {
    result.caseArea = 'PI/General';
    result.caseAreaLabel = 'Personal Injury / General';
  }

  // If we found nothing useful at all
  if (!result.caseArea && result.serviceTypes.length === 0 && !result.side) {
    // Try the old simple match as fallback
    const simple = firstLine.match(/^\d{4}\s+(MAT|EMP|PI|WC|Transition)/i);
    if (simple) {
      const key = simple[1].toUpperCase();
      result.caseArea = key;
      result.caseAreaLabel = CASE_AREA_LABELS[key] || key;
    }
  }

  return result;
}

// Derive a single display label for the case
function getCaseTypeLabel(parsed) {
  if (parsed.caseAreaLabel) return parsed.caseAreaLabel;
  if (parsed.serviceLabels.length > 0) return parsed.serviceLabels[0];
  return 'Unknown';
}

function getServiceLabel(parsed) {
  if (parsed.serviceLabels.length > 0) return parsed.serviceLabels.join(' + ');
  return 'Not Specified';
}

// Parse referring attorney from details
function parseAttorney(details) {
  if (!details) return null;
  const match = details.match(/(?:Atty|Attorney)\s*:\s*(.+)/i);
  if (match) {
    let name = match[1].replace(/,?\s*Esq\.?$/i, '').replace(/,?\s*Associate$/i, '').trim();
    name = name.split(/\s*\(/).shift().trim();
    return name || null;
  }
  return null;
}

// Parse firm from details
function parseFirm(details) {
  if (!details) return null;
  const match = details.match(/Firm\s*:\s*(.+)/i);
  if (match) return match[1].trim();
  return null;
}

// Parse email from details
function parseEmail(details) {
  if (!details) return null;
  // Look for Email: or E: lines before the Para section
  const lines = details.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^Para\s*:/i.test(line)) break; // stop at paralegal section
    const emailMatch = line.match(/(?:Email|E)\s*:\s*([\w.+\-]+@[\w.\-]+\.\w+)/i);
    if (emailMatch) return emailMatch[1];
  }
  // Fallback: find any email in the first 8 lines
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const m = lines[i].match(/([\w.+\-]+@[\w.\-]+\.\w+)/);
    if (m) return m[1];
  }
  return null;
}

// Parse phone from details
function parsePhone(details) {
  if (!details) return null;
  const lines = details.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^Para\s*:/i.test(line)) break;
    const phoneMatch = line.match(/(?:Direct|Tel|T|Phone|O|Main)\s*:\s*(.+)/i);
    if (phoneMatch) {
      const val = phoneMatch[1].trim();
      if (val && val.length > 5) return val;
    }
  }
  return null;
}

async function generate() {
  if (!client) init();

  log.info('Generating report...');

  const [opportunities, contacts, organisations, pipelines, stages] = await Promise.all([
    fetchAll('/Opportunities'),
    fetchAll('/Contacts'),
    fetchAll('/Organisations'),
    client.get('/Pipelines').then(r => r.data),
    client.get('/PipelineStages').then(r => r.data),
  ]);

  // Build lookup maps
  const stageMap = {};
  stages.forEach(s => { stageMap[s.STAGE_ID] = s; });

  // Parse all opportunities
  const parsed = opportunities.map(o => ({
    opp: o,
    case: parseCase(o.OPPORTUNITY_DETAILS),
    attorney: parseAttorney(o.OPPORTUNITY_DETAILS),
    firm: parseFirm(o.OPPORTUNITY_DETAILS),
    email: parseEmail(o.OPPORTUNITY_DETAILS),
    phone: parsePhone(o.OPPORTUNITY_DETAILS),
  }));

  // --- Aggregations ---

  // 1. Cases by area (Matrimonial, Employment, PI, etc.)
  const casesByArea = {};
  parsed.forEach(p => {
    const label = getCaseTypeLabel(p.case);
    casesByArea[label] = (casesByArea[label] || 0) + 1;
  });

  // 2. Cases by service type (VE, LCP, ECON, etc.)
  const casesByService = {};
  parsed.forEach(p => {
    if (p.case.serviceTypes.length > 0) {
      p.case.serviceTypes.forEach(st => {
        const label = SERVICE_TYPE_LABELS[st] || st;
        casesByService[label] = (casesByService[label] || 0) + 1;
      });
    } else {
      casesByService['Not Specified'] = (casesByService['Not Specified'] || 0) + 1;
    }
  });

  // 3. Cases by side (Plaintiff vs Defense)
  const casesBySide = {};
  parsed.forEach(p => {
    const side = p.case.sideLabel || 'Not Specified';
    casesBySide[side] = (casesBySide[side] || 0) + 1;
  });

  // 4. Cases by year
  const casesByYear = {};
  parsed.forEach(p => {
    const year = p.case.year || 'Unknown';
    casesByYear[year] = (casesByYear[year] || 0) + 1;
  });

  // 5. Cases by state (open vs won/closed)
  const casesByState = {};
  parsed.forEach(p => {
    const state = p.opp.OPPORTUNITY_STATE || 'Unknown';
    casesByState[state] = (casesByState[state] || 0) + 1;
  });

  // 6. Pipeline stage distribution
  const casesByStage = {};
  parsed.forEach(p => {
    const stage = p.opp.STAGE_ID ? (stageMap[p.opp.STAGE_ID] || {}).STAGE_NAME || 'Unknown' : 'No Stage';
    casesByStage[stage] = (casesByStage[stage] || 0) + 1;
  });

  // 7. Year-over-year by case area (for stacked chart)
  const yearByArea = {};
  parsed.forEach(p => {
    const year = p.case.year;
    if (!year) return;
    const area = getCaseTypeLabel(p.case);
    if (!yearByArea[year]) yearByArea[year] = {};
    yearByArea[year][area] = (yearByArea[year][area] || 0) + 1;
  });

  // 8. Service mix by side
  const serviceBySide = { Plaintiff: {}, Defense: {}, 'Not Specified': {} };
  parsed.forEach(p => {
    const side = p.case.sideLabel || 'Not Specified';
    const service = getServiceLabel(p.case);
    if (!serviceBySide[side]) serviceBySide[side] = {};
    serviceBySide[side][service] = (serviceBySide[side][service] || 0) + 1;
  });

  // 9. Top referring attorneys
  const attorneyCounts = {};
  parsed.forEach(p => {
    if (p.attorney && p.attorney !== 'Currently pro se') {
      const firm = p.firm || 'Unknown Firm';
      const key = `${p.attorney}|||${firm}`;
      if (!attorneyCounts[key]) {
        attorneyCounts[key] = { name: p.attorney, firm, email: null, phone: null, count: 0, cases: [], caseTypes: {}, services: {}, lastReferral: null };
      }
      if (p.email && !attorneyCounts[key].email) attorneyCounts[key].email = p.email;
      if (p.phone && !attorneyCounts[key].phone) attorneyCounts[key].phone = p.phone;
      attorneyCounts[key].count++;
      attorneyCounts[key].cases.push(p.opp.OPPORTUNITY_NAME);
      const area = getCaseTypeLabel(p.case);
      attorneyCounts[key].caseTypes[area] = (attorneyCounts[key].caseTypes[area] || 0) + 1;
      p.case.serviceLabels.forEach(s => {
        attorneyCounts[key].services[s] = (attorneyCounts[key].services[s] || 0) + 1;
      });
      const created = new Date(p.opp.DATE_CREATED_UTC);
      if (!attorneyCounts[key].lastReferral || created > attorneyCounts[key].lastReferral) {
        attorneyCounts[key].lastReferral = created;
      }
    }
  });
  const topAttorneys = Object.values(attorneyCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  // 10. Top referring firms
  const firmCounts = {};
  parsed.forEach(p => {
    if (p.firm) {
      if (!firmCounts[p.firm]) {
        firmCounts[p.firm] = { name: p.firm, count: 0, attorneys: new Set(), lastReferral: null, caseTypes: {}, services: {} };
      }
      firmCounts[p.firm].count++;
      if (p.attorney) firmCounts[p.firm].attorneys.add(p.attorney);
      const area = getCaseTypeLabel(p.case);
      firmCounts[p.firm].caseTypes[area] = (firmCounts[p.firm].caseTypes[area] || 0) + 1;
      p.case.serviceLabels.forEach(s => {
        firmCounts[p.firm].services[s] = (firmCounts[p.firm].services[s] || 0) + 1;
      });
      const created = new Date(p.opp.DATE_CREATED_UTC);
      if (!firmCounts[p.firm].lastReferral || created > firmCounts[p.firm].lastReferral) {
        firmCounts[p.firm].lastReferral = created;
      }
    }
  });
  const topFirms = Object.values(firmCounts)
    .map(f => ({ ...f, attorneys: [...f.attorneys], attorneyCount: f.attorneys.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  // 11. Marketing action lists (with emails)
  const now = new Date();
  const allAttorneys = Object.values(attorneyCounts);

  // Cold: referred 2+ times but nothing in 90+ days
  const coldAttorneys = allAttorneys
    .filter(a => {
      const daysSince = (now - a.lastReferral) / (1000 * 60 * 60 * 24);
      return daysSince > 90 && a.count >= 2;
    })
    .sort((a, b) => b.count - a.count);

  // New: first-time referrers (most recent first)
  const newReferrers = allAttorneys
    .filter(a => a.count === 1)
    .sort((a, b) => b.lastReferral - a.lastReferral);

  // VIP: top referrers (5+ cases) — nurture and protect
  const vipReferrers = allAttorneys
    .filter(a => a.count >= 5)
    .sort((a, b) => b.count - a.count);

  // Warming: referred 2-4 times, last referral within 180 days — potential to grow
  const warmingReferrers = allAttorneys
    .filter(a => {
      const daysSince = (now - a.lastReferral) / (1000 * 60 * 60 * 24);
      return a.count >= 2 && a.count <= 4 && daysSince <= 180;
    })
    .sort((a, b) => b.count - a.count);

  // CEO: Year-over-year growth
  const yearKeys = Object.keys(casesByYear).filter(k => k !== 'Unknown').map(Number).sort();
  const currentYear = yearKeys[yearKeys.length - 1];
  const prevYear = yearKeys[yearKeys.length - 2];
  const currentYearCases = casesByYear[currentYear] || 0;
  const prevYearCases = casesByYear[prevYear] || 0;
  const yoyGrowth = prevYearCases > 0 ? Math.round((currentYearCases - prevYearCases) / prevYearCases * 100) : 0;

  // CEO: Plaintiff/Defense split percentages
  const totalWithSide = (casesBySide['Plaintiff'] || 0) + (casesBySide['Defense'] || 0);
  const pltPct = totalWithSide > 0 ? Math.round((casesBySide['Plaintiff'] || 0) / totalWithSide * 100) : 0;
  const defPct = totalWithSide > 0 ? Math.round((casesBySide['Defense'] || 0) / totalWithSide * 100) : 0;

  // CEO: Top case area
  const topArea = Object.entries(casesByArea)
    .filter(([k]) => k !== 'Unknown')
    .sort((a, b) => b[1] - a[1])[0];

  // CEO: Concentration risk — what % of cases come from top 5 firms
  const allFirmsList = Object.values(firmCounts).sort((a, b) => b.count - a.count);
  const top5FirmCases = allFirmsList.slice(0, 5).reduce((sum, f) => sum + f.count, 0);
  const totalFirmCases = allFirmsList.reduce((sum, f) => sum + f.count, 0);
  const concentrationPct = totalFirmCases > 0 ? Math.round(top5FirmCases / totalFirmCases * 100) : 0;

  // 13. Summary
  const classifiedCount = parsed.filter(p => getCaseTypeLabel(p.case) !== 'Unknown').length;
  const summary = {
    totalOpportunities: opportunities.length,
    openCases: opportunities.filter(o => o.OPPORTUNITY_STATE === 'OPEN').length,
    wonCases: opportunities.filter(o => o.OPPORTUNITY_STATE === 'WON').length,
    totalContacts: contacts.length,
    totalOrganizations: organisations.length,
    uniqueAttorneys: Object.keys(attorneyCounts).length,
    uniqueFirms: Object.keys(firmCounts).length,
    classifiedCases: classifiedCount,
    unclassifiedCases: opportunities.length - classifiedCount,
    classificationRate: Math.round(classifiedCount / opportunities.length * 100),
  };

  log.info(`Report generated — ${summary.classificationRate}% cases classified`);

  // COO metrics: operations, throughput, bottlenecks
  const openByStage = {};
  const openByArea = {};
  parsed.forEach(p => {
    if (p.opp.OPPORTUNITY_STATE === 'OPEN') {
      const stage = p.opp.STAGE_ID ? (stageMap[p.opp.STAGE_ID] || {}).STAGE_NAME || 'Unknown' : 'No Stage';
      openByStage[stage] = (openByStage[stage] || 0) + 1;
      const area = getCaseTypeLabel(p.case);
      openByArea[area] = (openByArea[area] || 0) + 1;
    }
  });

  // Cases by side for open only
  const openBySide = { Plaintiff: 0, Defense: 0 };
  parsed.forEach(p => {
    if (p.opp.OPPORTUNITY_STATE === 'OPEN' && p.case.sideLabel) {
      openBySide[p.case.sideLabel] = (openBySide[p.case.sideLabel] || 0) + 1;
    }
  });

  // Service distribution for open cases
  const openByService = {};
  parsed.forEach(p => {
    if (p.opp.OPPORTUNITY_STATE === 'OPEN') {
      p.case.serviceTypes.forEach(st => {
        const label = SERVICE_TYPE_LABELS[st] || st;
        openByService[label] = (openByService[label] || 0) + 1;
      });
    }
  });

  // Cases opened per month (last 12 months)
  const monthlyIntake = {};
  parsed.forEach(p => {
    if (p.case.year) {
      const created = new Date(p.opp.DATE_CREATED_UTC);
      const key = `${created.getFullYear()}-${String(created.getMonth()+1).padStart(2,'0')}`;
      monthlyIntake[key] = (monthlyIntake[key] || 0) + 1;
    }
  });

  // Average cases per month (current year)
  const currentYearMonths = Object.entries(monthlyIntake)
    .filter(([k]) => k.startsWith(String(currentYear)))
    .map(([,v]) => v);
  const avgMonthlyIntake = currentYearMonths.length > 0
    ? Math.round(currentYearMonths.reduce((a,b) => a+b, 0) / currentYearMonths.length)
    : 0;

  const cooMetrics = {
    openCases: summary.openCases,
    completedCases: summary.wonCases,
    completionRate: opportunities.length > 0 ? Math.round(summary.wonCases / summary.totalOpportunities * 100) : 0,
    openByStage,
    openByArea,
    openBySide,
    openByService,
    monthlyIntake,
    avgMonthlyIntake,
    // Bottleneck: stage with most open cases
    bottleneckStage: Object.entries(openByStage).sort((a,b) => b[1] - a[1])[0] || null,
  };

  // CEO metrics
  const ceoMetrics = {
    currentYear,
    prevYear,
    currentYearCases,
    prevYearCases,
    yoyGrowth,
    pltPct,
    defPct,
    topArea: topArea ? { name: topArea[0], count: topArea[1] } : null,
    concentrationPct,
    top5Firms: allFirmsList.slice(0, 5).map(f => ({ name: f.name, count: f.count, attorneyCount: f.attorneys ? f.attorneys.size || f.attorneys.length : 0 })),
    completionRate: opportunities.length > 0 ? Math.round(summary.wonCases / summary.totalOpportunities * 100) : 0,
  };

  return {
    summary,
    casesByArea,
    casesByService,
    casesBySide,
    casesByYear,
    casesByState,
    casesByStage,
    yearByArea,
    serviceBySide,
    topAttorneys,
    topFirms,
    coldAttorneys,
    newReferrers,
    vipReferrers,
    warmingReferrers,
    ceoMetrics,
    cooMetrics,
  };
}

module.exports = { generate };
