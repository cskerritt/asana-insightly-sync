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

// Parse opposing counsel
function parseOpposingCounsel(details) {
  if (!details) return null;
  const match = details.match(/Opposing\s+Counsel\s*:\s*(.+)/i);
  if (!match) return null;
  let name = match[1].replace(/,?\s*Esq\.?$/i, '').trim();
  if (!name || name.length < 2) return null;
  // Filter field labels that got captured
  if (/^(Email|E|T|Firm|Direct|Phone|Address|N\/A)\s*[:@]/i.test(name)) return null;
  if (/^(N\/A|TBD|None|Unknown)$/i.test(name)) return null;
  return name;
}

// Parse opposing firm
function parseOpposingFirm(details) {
  if (!details) return null;
  const lines = details.split('\n');
  let foundOC = false;
  for (const line of lines) {
    if (/Opposing\s+Counsel/i.test(line)) { foundOC = true; continue; }
    if (foundOC && /^Firm\s*:\s*/i.test(line.trim())) {
      return line.trim().replace(/^Firm\s*:\s*/i, '').trim() || null;
    }
  }
  return null;
}

// Parse city/state from details
function parseLocation(details) {
  if (!details) return null;
  const match = details.match(/([A-Za-z\s.]+),\s*([A-Z]{2})\s+(\d{5})/);
  if (match) return { city: match[1].trim(), state: match[2], zip: match[3] };
  return null;
}

// Parse paralegal info
function parseParalegal(details) {
  if (!details) return null;
  const match = details.match(/Para\s*:\s*(.+)/i);
  if (!match) return null;
  let name = match[1].trim();
  if (!name) return null;
  // Filter out false positives — field labels that follow Para:
  const junkPatterns = /^(T|E|Direct|Tel|Phone|Email|Firm|Fax|Main|O|C|Cell|Mobile|Address|Opposing|Client|Interview|Due|Court|Case)\s*:/i;
  if (junkPatterns.test(name)) return null;
  // Remove trailing asterisks and clean
  name = name.replace(/\*+$/, '').trim();
  if (name.length < 2) return null;
  // Find para email
  const lines = details.split('\n');
  let foundPara = false;
  let email = null;
  for (const line of lines) {
    if (/^Para\s*:/i.test(line.trim())) { foundPara = true; continue; }
    if (foundPara) {
      const em = line.match(/(?:E|Email)\s*:\s*([\w.+\-]+@[\w.\-]+\.\w+)/i);
      if (em) { email = em[1]; break; }
      if (/^(Client|Opposing|Interview|Due)/i.test(line.trim())) break;
    }
  }
  return { name, email };
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
    opposingCounsel: parseOpposingCounsel(o.OPPORTUNITY_DETAILS),
    opposingFirm: parseOpposingFirm(o.OPPORTUNITY_DETAILS),
    location: parseLocation(o.OPPORTUNITY_DETAILS),
    paralegal: parseParalegal(o.OPPORTUNITY_DETAILS),
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

  // === NEW FEATURE 1: Referral Velocity ===
  const velocityAlerts = [];
  allAttorneys.forEach(a => {
    if (a.count < 2) return;
    // Get all referral dates for this attorney
    const dates = [];
    parsed.forEach(p => {
      if (p.attorney === a.name && p.firm === a.firm) {
        dates.push(new Date(p.opp.DATE_CREATED_UTC));
      }
    });
    dates.sort((a, b) => a - b);
    if (dates.length < 2) return;
    // Calculate average gap between referrals
    let totalGap = 0;
    for (let i = 1; i < dates.length; i++) {
      totalGap += (dates[i] - dates[i - 1]) / 86400000;
    }
    const avgGapDays = Math.round(totalGap / (dates.length - 1));
    const daysSinceLast = Math.round((now - dates[dates.length - 1]) / 86400000);
    const ratio = avgGapDays > 0 ? daysSinceLast / avgGapDays : 0;

    let status = 'regular';
    if (ratio >= 2) status = 'stalled';
    else if (ratio >= 1.5) status = 'slowing';

    if (status !== 'regular') {
      velocityAlerts.push({
        name: a.name, firm: a.firm, email: a.email, phone: a.phone,
        count: a.count, avgGapDays, daysSinceLast, status, ratio: Math.round(ratio * 10) / 10,
      });
    }
  });
  velocityAlerts.sort((a, b) => b.count - a.count);

  // === NEW FEATURE 2: Geographic Targeting ===
  const geoByState = {};
  const geoByCity = {};
  let locatedCount = 0;
  parsed.forEach(p => {
    if (p.location) {
      locatedCount++;
      const st = p.location.state;
      geoByState[st] = (geoByState[st] || 0) + 1;
      const cityKey = `${p.location.city}, ${st}`;
      geoByCity[cityKey] = (geoByCity[cityKey] || 0) + 1;
    }
  });
  const topCities = Object.entries(geoByCity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));
  const topStates = Object.entries(geoByState)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // === NEW FEATURE 3: Opposing Counsel as Leads ===
  const ocCounts = {};
  parsed.forEach(p => {
    if (p.opposingCounsel && p.opposingCounsel !== 'N/A') {
      const firm = p.opposingFirm || 'Unknown Firm';
      const key = `${p.opposingCounsel}|||${firm}`;
      if (!ocCounts[key]) {
        ocCounts[key] = { name: p.opposingCounsel, firm, count: 0, cases: [] };
      }
      ocCounts[key].count++;
      ocCounts[key].cases.push(p.opp.OPPORTUNITY_NAME);
    }
  });
  const opposingCounselLeads = Object.values(ocCounts)
    .filter(oc => oc.count >= 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  // === NEW FEATURE 4: Paralegal Tracking ===
  const paralegals = {};
  parsed.forEach(p => {
    if (p.paralegal && p.paralegal.name) {
      const key = p.paralegal.name.toLowerCase();
      if (!paralegals[key]) {
        paralegals[key] = { name: p.paralegal.name, email: p.paralegal.email, firms: new Set(), count: 0 };
      }
      paralegals[key].count++;
      if (p.firm) paralegals[key].firms.add(p.firm);
      if (p.paralegal.email && !paralegals[key].email) paralegals[key].email = p.paralegal.email;
    }
  });
  const paralegalList = Object.values(paralegals)
    .map(p => ({ ...p, firms: [...p.firms] }))
    .sort((a, b) => b.count - a.count);

  // === NEW FEATURE 5: Cross-Sell Opportunities ===
  const allServiceNames = Object.keys(SERVICE_TYPE_LABELS);
  const crossSellOpps = [];
  const allFirmsForCS = Object.values(firmCounts).filter(f => f.count >= 3);
  allFirmsForCS.forEach(f => {
    const firmServices = Object.keys(f.services || {});
    const missing = allServiceNames
      .filter(s => !firmServices.includes(SERVICE_TYPE_LABELS[s]))
      .map(s => SERVICE_TYPE_LABELS[s])
      .filter(s => ['Vocational Evaluation', 'Life Care Plan', 'Economics', 'Loss of Household Services'].includes(s));
    if (missing.length > 0 && missing.length < 4) {
      crossSellOpps.push({
        firm: f.name,
        count: f.count,
        currentServices: firmServices,
        missingServices: missing,
        attorneyCount: f.attorneys ? (f.attorneys.size || f.attorneys.length) : 0,
      });
    }
  });
  crossSellOpps.sort((a, b) => b.count - a.count);

  // === NEW: Pipeline Stage Timing ===
  // How long cases sit at each pipeline stage
  const stageTiming = {};
  stages.forEach(s => {
    const casesAtStage = opportunities.filter(o => o.STAGE_ID === s.STAGE_ID && o.OPPORTUNITY_STATE === 'OPEN');
    if (casesAtStage.length > 0) {
      const avgDays = Math.round(casesAtStage.reduce((sum, o) => {
        return sum + (now - new Date(o.DATE_UPDATED_UTC)) / 86400000;
      }, 0) / casesAtStage.length);
      stageTiming[s.STAGE_NAME] = { count: casesAtStage.length, avgDaysAtStage: avgDays, pipelineId: s.PIPELINE_ID };
    }
  });

  // === NEW: Revenue Forecasting ===
  // Standard fee estimates by service type
  const SERVICE_FEES = {
    'Vocational Evaluation': 5500,
    'Life Care Plan': 7500,
    'Economics': 6000,
    'Loss of Household Services': 4500,
    'Consulting Medical Exam': 3500,
    'Independent Medical Exam': 3000,
    'Records Review': 2000,
    'Rebuttal': 3000,
    'Critique': 2500,
    'Affidavit': 1500,
  };
  let estimatedOpenRevenue = 0;
  let estimatedCompletedRevenue = 0;
  let currentYearRevenue = 0;
  parsed.forEach(p => {
    let caseFee = 0;
    if (p.case.serviceLabels.length > 0) {
      p.case.serviceLabels.forEach(s => { caseFee += SERVICE_FEES[s] || 3000; });
    } else {
      caseFee = 4000; // default estimate
    }
    if (p.opp.OPPORTUNITY_STATE === 'OPEN') estimatedOpenRevenue += caseFee;
    else estimatedCompletedRevenue += caseFee;
    if (p.case.year === currentYear) currentYearRevenue += caseFee;
  });

  // Revenue by year
  const revenueByYear = {};
  parsed.forEach(p => {
    if (!p.case.year) return;
    let fee = 0;
    if (p.case.serviceLabels.length > 0) {
      p.case.serviceLabels.forEach(s => { fee += SERVICE_FEES[s] || 3000; });
    } else {
      fee = 4000;
    }
    revenueByYear[p.case.year] = (revenueByYear[p.case.year] || 0) + fee;
  });

  // === NEW: Referral-to-Completion Cycle ===
  const cycleTimes = {};
  parsed.forEach(p => {
    if (p.firm && p.opp.OPPORTUNITY_STATE === 'WON' && p.opp.ACTUAL_CLOSE_DATE) {
      const created = new Date(p.opp.DATE_CREATED_UTC);
      const closed = new Date(p.opp.ACTUAL_CLOSE_DATE);
      const days = Math.round((closed - created) / 86400000);
      if (days > 0 && days < 1000) {
        if (!cycleTimes[p.firm]) cycleTimes[p.firm] = { firm: p.firm, times: [], count: 0 };
        cycleTimes[p.firm].times.push(days);
        cycleTimes[p.firm].count++;
      }
    }
  });
  const firmCycleTimes = Object.values(cycleTimes)
    .filter(f => f.count >= 3)
    .map(f => ({
      firm: f.firm,
      count: f.count,
      avgDays: Math.round(f.times.reduce((a, b) => a + b, 0) / f.times.length),
      fastest: Math.round(Math.min(...f.times)),
      slowest: Math.round(Math.max(...f.times)),
    }))
    .sort((a, b) => a.avgDays - b.avgDays);

  // Overall cycle time
  const allCycleTimes = Object.values(cycleTimes).flatMap(f => f.times);
  const overallAvgCycle = allCycleTimes.length
    ? Math.round(allCycleTimes.reduce((a, b) => a + b, 0) / allCycleTimes.length)
    : 0;

  // === NEW: Seasonal Patterns ===
  const monthlyReferrals = {};
  parsed.forEach(p => {
    const created = new Date(p.opp.DATE_CREATED_UTC);
    const monthKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`;
    monthlyReferrals[monthKey] = (monthlyReferrals[monthKey] || 0) + 1;
  });

  // Average by month of year (Jan=1, Dec=12)
  const seasonalAvg = {};
  const seasonalCounts = {};
  parsed.forEach(p => {
    const month = new Date(p.opp.DATE_CREATED_UTC).getMonth() + 1;
    const monthName = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month];
    if (!seasonalCounts[monthName]) seasonalCounts[monthName] = [];
    seasonalCounts[monthName].push(1);
  });
  // Group by year first to get per-year-month counts, then average
  const yearMonthCounts = {};
  parsed.forEach(p => {
    const d = new Date(p.opp.DATE_CREATED_UTC);
    const ym = `${d.getFullYear()}-${d.getMonth()}`;
    yearMonthCounts[ym] = (yearMonthCounts[ym] || 0) + 1;
  });
  const monthTotals = {};
  const monthYearCount = {};
  Object.entries(yearMonthCounts).forEach(([ym, count]) => {
    const month = parseInt(ym.split('-')[1]);
    const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month];
    monthTotals[monthName] = (monthTotals[monthName] || 0) + count;
    monthYearCount[monthName] = (monthYearCount[monthName] || 0) + 1;
  });
  const seasonal = {};
  Object.entries(monthTotals).forEach(([month, total]) => {
    seasonal[month] = Math.round(total / (monthYearCount[month] || 1));
  });

  const revenueMetrics = {
    estimatedOpenRevenue,
    estimatedCompletedRevenue,
    currentYearRevenue,
    revenueByYear,
    totalEstimatedRevenue: estimatedOpenRevenue + estimatedCompletedRevenue,
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
    // New features
    velocityAlerts,
    geographic: { topStates, topCities, locatedCount },
    opposingCounselLeads,
    paralegalList,
    crossSellOpps,
    // Business intelligence
    stageTiming,
    revenueMetrics,
    firmCycleTimes,
    overallAvgCycle,
    seasonal,
    monthlyReferrals,
  };
}

module.exports = { generate };
