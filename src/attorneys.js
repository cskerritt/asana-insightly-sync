const axios = require('axios');
const cheerio = require('cheerio');
const log = require('./logger');
const db = require('./db');
const insightly = require('./insightly');

const REQUEST_DELAY = 2500;
const MAX_PAGES = 20;

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

const PRACTICE_AREAS = [
  { name: 'Personal Injury', slug: 'personal-injury', query: 'personal+injury' },
  { name: 'Family Law', slug: 'family-law', query: 'family+law' },
  { name: 'Employment Law', slug: 'employment-law', query: 'employment+law' },
  { name: 'Criminal Defense', slug: 'criminal-defense', query: 'criminal+defense' },
  { name: 'Business/Corporate', slug: 'business-corporate', query: 'business+law' },
  { name: 'Real Estate', slug: 'real-estate', query: 'real+estate' },
  { name: 'Estate Planning', slug: 'estate-planning', query: 'estate+planning' },
  { name: 'Bankruptcy', slug: 'bankruptcy', query: 'bankruptcy' },
  { name: 'Immigration', slug: 'immigration', query: 'immigration' },
  { name: 'Intellectual Property', slug: 'intellectual-property', query: 'intellectual+property' },
  { name: 'Tax Law', slug: 'tax-law', query: 'tax+law' },
  { name: 'Medical Malpractice', slug: 'medical-malpractice', query: 'medical+malpractice' },
  { name: 'Workers Compensation', slug: 'workers-compensation', query: 'workers+compensation' },
  { name: 'Civil Rights', slug: 'civil-rights', query: 'civil+rights' },
  { name: 'Environmental Law', slug: 'environmental-law', query: 'environmental+law' },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeAvvo(state, practiceAreaSlug) {
  const stateName = STATE_NAMES[state.toUpperCase()] || state;
  const pa = PRACTICE_AREAS.find(p => p.slug === practiceAreaSlug);
  const query = pa ? pa.query : practiceAreaSlug.replace(/-/g, '+');
  const baseUrl = `https://www.avvo.com/search/lawyer_search?q=${query}&loc=${stateName}`;

  const allRecords = [];
  let url = baseUrl;

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      });
      const $ = cheerio.load(response.data);
      const cards = $('.serp-card');

      if (cards.length === 0) break;

      cards.each((_, card) => {
        const record = parseCard($, card, state.toUpperCase());
        if (record) allRecords.push(record);
      });

      const nextLink = $('a.pagination-next').attr('href');
      if (!nextLink) break;

      url = nextLink.startsWith('http') ? nextLink : `https://www.avvo.com${nextLink}`;

      if (page < MAX_PAGES) await sleep(REQUEST_DELAY);
    } catch (err) {
      log.error(`Avvo scrape failed for page ${page}`, err.message);
      break;
    }
  }

  return allRecords;
}

function parseCard($, card, state) {
  const $card = $(card);

  const nameEl = $card.find("[itemprop='name']").first();
  if (!nameEl.length) return null;
  const fullName = nameEl.text().trim();
  const lastSpace = fullName.lastIndexOf(' ');
  const firstName = lastSpace > 0 ? fullName.substring(0, lastSpace) : fullName;
  const lastName = lastSpace > 0 ? fullName.substring(lastSpace + 1) : '';

  const firmEl = $card.find("[itemprop='worksFor']").first();
  const firmName = firmEl.length ? firmEl.text().trim() : '';

  const phoneEl = $card.find('a.phone-cta').first();
  const phone = phoneEl.length ? phoneEl.text().trim() : null;

  const addrParts = [];
  for (const field of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode']) {
    const el = $card.find(`[itemprop='${field}']`).first();
    if (el.length) addrParts.push(el.text().trim());
  }
  const firmAddress = addrParts.length > 0 ? addrParts.join(', ') : null;

  const linkEl = $card.find('a.header').first();
  let sourceUrl = '';
  if (linkEl.length) {
    const href = linkEl.attr('href') || '';
    sourceUrl = href.startsWith('http') ? href : `https://www.avvo.com${href}`;
  }

  const practiceAreas = [];
  $card.find('.practice-areas li').each((_, li) => {
    practiceAreas.push($(li).text().trim());
  });

  return {
    firstName, lastName, phone, firmName, firmAddress, state,
    practiceAreas, source: 'avvo', sourceUrl,
  };
}

async function runSearch(state, practiceAreaSlug) {
  const logId = db.createSearchLog(state, practiceAreaSlug, 'avvo');

  try {
    log.info(`Starting attorney search: ${state} / ${practiceAreaSlug}`);
    const records = await scrapeAvvo(state, practiceAreaSlug);

    let newCount = 0;
    for (const record of records) {
      const result = db.upsertAttorney(record);
      if (result.created) newCount++;
    }

    db.updateSearchLog(logId, 'completed', records.length);
    log.info(`Attorney search complete: ${records.length} found, ${newCount} new`);
    return { status: 'completed', totalFound: records.length, newCount, logId };
  } catch (err) {
    log.error(`Attorney search failed: ${state} / ${practiceAreaSlug}`, err.message);
    db.updateSearchLog(logId, 'failed', 0);
    return { status: 'failed', totalFound: 0, newCount: 0, logId };
  }
}

async function pushToInsightly(attorneyIds) {
  const results = { success: 0, skipped: 0, failed: 0 };

  for (const id of attorneyIds) {
    try {
      const attorney = db.getAttorneyById(id);
      if (!attorney) { results.failed++; continue; }

      const existing = await insightly.searchContacts(attorney.first_name, attorney.last_name);
      if (existing.length > 0) {
        const contactId = existing[0].CONTACT_ID;
        db.setAttorneyInsightlyId(id, contactId);
        results.skipped++;
        await sleep(500);
        continue;
      }

      const contact = await insightly.createContact({
        firstName: attorney.first_name,
        lastName: attorney.last_name,
        email: attorney.email || null,
        phone: attorney.phone || null,
      });

      const contactId = contact.CONTACT_ID;
      db.setAttorneyInsightlyId(id, contactId);

      await insightly.addTagToContact(contactId, attorney.state);

      const practiceAreas = JSON.parse(attorney.practice_areas || '[]');
      for (const pa of practiceAreas) {
        await insightly.addTagToContact(contactId, pa);
      }

      results.success++;
    } catch (err) {
      log.error(`Failed to push attorney ${id} to Insightly`, err.message);
      results.failed++;
    }
    await sleep(500);
  }

  return results;
}

module.exports = {
  STATE_NAMES, PRACTICE_AREAS,
  scrapeAvvo, runSearch, pushToInsightly,
};
