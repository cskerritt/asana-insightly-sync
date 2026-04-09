/**
 * Parses referring attorney, firm, paralegal, opposing counsel,
 * and address info from Asana task notes.
 */

const US_STATES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',
  MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',
  OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
  WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia',
};

function parseNotes(notes) {
  if (!notes) return null;

  const lines = notes.split('\n').map(l => l.trim()).filter(Boolean);
  const result = {
    attorneyName: null,
    firmName: null,
    email: null,
    phone: null,
    paraName: null,
    paraEmail: null,
    paraPhone: null,
    opposingCounsel: null,
    opposingFirm: null,
    caseType: null,
    dueDate: null,
    // New fields
    address: null,
    city: null,
    state: null,
    zip: null,
    clientName: null,
  };

  let inParaSection = false;
  let pastOpposingCounsel = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Case type (first line often like "2026 MAT", "2025 EMP")
    if (i === 0 && /^\d{4}\s+/i.test(line)) {
      result.caseType = line.replace(/[:\s]+$/, '');
      continue;
    }

    // Attorney name
    if (/^(Atty|Attorney)\s*:\s*/i.test(line) && !inParaSection) {
      result.attorneyName = cleanValue(line.replace(/^(Atty|Attorney)\s*:\s*/i, ''));
      continue;
    }

    // Firm — first occurrence is referring firm, after opposing counsel is opposing firm
    if (/^Firm\s*:\s*/i.test(line)) {
      const val = cleanValue(line.replace(/^Firm\s*:\s*/i, ''));
      if (pastOpposingCounsel && !result.opposingFirm) {
        result.opposingFirm = val;
      } else if (!result.firmName) {
        result.firmName = val;
      }
      continue;
    }

    // Address line
    if (/^Address\s*:\s*/i.test(line)) {
      result.address = cleanValue(line.replace(/^Address\s*:\s*/i, ''));
      continue;
    }

    // Look for city/state/zip patterns anywhere (e.g., "New York, NY 10017")
    if (!result.state) {
      const csz = line.match(/([A-Za-z\s.]+),\s*([A-Z]{2})\s+(\d{5})/);
      if (csz) {
        result.city = csz[1].trim();
        result.state = csz[2];
        result.zip = csz[3];
        if (!result.address) result.address = line;
        continue;
      }
    }

    // Email — context-sensitive
    if (/^(Email|E)\s*:\s*/i.test(line)) {
      const val = cleanValue(line.replace(/^(Email|E)\s*:\s*/i, ''));
      if (val && val.includes('@')) {
        const emailAddr = val.split(/\s/)[0];
        if (inParaSection && !result.paraEmail) {
          result.paraEmail = emailAddr;
        } else if (!inParaSection && !result.email) {
          result.email = emailAddr;
        }
      }
      continue;
    }

    // Phone — context-sensitive
    if (/^(Direct|Tel|T|Phone|O|Main|C|Cell|Mobile|Fax)\s*:\s*/i.test(line)) {
      const val = cleanValue(line.replace(/^(Direct|Tel|T|Phone|O|Main|C|Cell|Mobile|Fax)\s*:\s*/i, ''));
      if (val && val.length > 5) {
        if (inParaSection && !result.paraPhone) {
          result.paraPhone = val;
        } else if (!inParaSection && !result.phone) {
          result.phone = val;
        }
      }
      continue;
    }

    // Paralegal
    if (/^Para\s*:\s*/i.test(line)) {
      result.paraName = cleanValue(line.replace(/^Para\s*:\s*/i, ''));
      inParaSection = true;
      continue;
    }

    // Client name
    if (/^Client\s*:\s*/i.test(line)) {
      result.clientName = cleanValue(line.replace(/^Client\s*:\s*/i, ''));
      inParaSection = false; // client line resets para section
      continue;
    }

    // Opposing counsel
    if (/^Opposing\s+Counsel\s*:\s*/i.test(line)) {
      result.opposingCounsel = cleanValue(line.replace(/^Opposing\s+Counsel\s*:\s*/i, ''));
      if (result.opposingCounsel) {
        result.opposingCounsel = result.opposingCounsel
          .replace(/,?\s*Esq\.?$/i, '').trim();
      }
      pastOpposingCounsel = true;
      inParaSection = false;
      continue;
    }

    // Due date
    if (/^Due\s+Date\s*:\s*/i.test(line)) {
      result.dueDate = cleanValue(line.replace(/^Due\s+Date\s*:\s*/i, ''));
      continue;
    }

    // Fallback: Esq. in early lines = attorney name
    if (!result.attorneyName && /Esq\.?/i.test(line) && i <= 3) {
      result.attorneyName = cleanValue(line.replace(/,?\s*Esq\.?/i, '').replace(/^(Atty|Attorney)\s*:\s*/i, ''));
      continue;
    }

    // Fallback: standalone email near top
    if (!result.email && /@/.test(line) && i <= 6 && !inParaSection && !/^(E|Email|Para)\s*:/i.test(line)) {
      const match = line.match(/[\w.+-]+@[\w.-]+\.\w+/);
      if (match) result.email = match[0];
    }
  }

  // Clean attorney name
  if (result.attorneyName) {
    result.attorneyName = result.attorneyName
      .replace(/,?\s*Esq\.?$/i, '')
      .replace(/,?\s*Associate$/i, '')
      .split(/\s*\(/).shift()
      .trim();
  }

  // Only return if we found at least an attorney or firm
  if (!result.attorneyName && !result.firmName) return null;

  return result;
}

function cleanValue(val) {
  if (!val) return null;
  val = val.replace(/\u00a0/g, ' ').trim();
  return val || null;
}

module.exports = { parseNotes, US_STATES };
