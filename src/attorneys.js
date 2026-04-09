const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const log = require('./logger');
const db = require('./db');
const insightly = require('./insightly');

const PAGE_LOAD_WAIT = 8000; // ms to wait for Cloudflare challenge
const REQUEST_DELAY = 3000;

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
  const searchUrl = `https://www.avvo.com/search/lawyer_search?q=${query}&loc=${stateName}`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: process.env.NODE_ENV === 'production',
      args: process.env.NODE_ENV === 'production'
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        : [],
    });
    const page = await browser.newPage();

    log.info(`Navigating to Avvo: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'load', timeout: 30000 });

    // Wait for attorney cards to actually render with names
    try {
      await page.waitForSelector('.serp-card .profile-name a', { timeout: 15000 });
    } catch {
      // Fallback: may still be on Cloudflare challenge page
      log.warn('Waiting extra time for page to load...');
      await page.waitForTimeout(PAGE_LOAD_WAIT);
    }
    // Extra buffer for remaining cards to populate
    await page.waitForTimeout(2000);

    // Extract attorney data from all cards on the page
    const records = await page.evaluate((st) => {
      const results = [];
      document.querySelectorAll('.serp-card').forEach(card => {
        // Name
        const nameEl = card.querySelector('.profile-name a');
        if (!nameEl) return;
        const fullName = nameEl.textContent.trim();
        const lastSpace = fullName.lastIndexOf(' ');
        const firstName = lastSpace > 0 ? fullName.substring(0, lastSpace) : fullName;
        const lastName = lastSpace > 0 ? fullName.substring(lastSpace + 1) : '';

        // Profile URL — extract real URL from ad redirect if present
        let sourceUrl = nameEl.getAttribute('href') || '';
        const urlMatch = sourceUrl.match(/url=([^&]+)/);
        if (urlMatch) sourceUrl = decodeURIComponent(urlMatch[1]);

        // Phone — extract number from CTA text
        const phoneEl = card.querySelector('.phone-cta');
        let phone = null;
        if (phoneEl) {
          const phoneMatch = phoneEl.textContent.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
          if (phoneMatch) phone = phoneMatch[0];
        }

        // Practice areas from details text
        const practiceAreas = [];
        const detailsEl = card.querySelector('.details') || card.querySelector('.body');
        if (detailsEl) {
          const text = detailsEl.textContent;
          const paMatch = text.match(/Practice Areas?:\s*(.+?)(?:\n|$)/);
          if (paMatch) {
            paMatch[1].split(',').forEach(p => {
              const trimmed = p.trim().replace(/\.{3}$/, '');
              if (trimmed && trimmed.length > 1) practiceAreas.push(trimmed);
            });
          }
        }

        results.push({
          firstName, lastName, phone,
          firmName: '', firmAddress: null,
          state: st, practiceAreas,
          source: 'avvo', sourceUrl,
        });
      });
      return results;
    }, state.toUpperCase());

    // Filter out any records with empty names (page didn't fully render)
    const validRecords = records.filter(r => r.firstName && r.firstName.trim());
    if (validRecords.length < records.length) {
      log.warn(`Filtered out ${records.length - validRecords.length} records with empty names`);
    }

    log.info(`Scraped ${validRecords.length} attorneys from Avvo`);
    await browser.close();
    return validRecords;
  } catch (err) {
    log.error('Avvo scrape failed', err.message);
    if (browser) await browser.close().catch(() => {});
    return [];
  }
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
