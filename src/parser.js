/**
 * Parses referring attorney and firm info from Asana task notes.
 *
 * Handles variations like:
 *   Atty: Name          Attorney: Name          Name, Esq.
 *   Firm: Name          Firm: Name
 *   Email: x            E: x                    name@domain.com on its own line
 *   Direct: x           Tel: x                  T: x            Phone: x
 */

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
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Case type (first line often like "2026 MAT", "2025 EMP", "2026 EMP, Defense")
    if (i === 0 && /^\d{4}\s+(MAT|EMP|PI|WC)/i.test(line)) {
      result.caseType = line.replace(/[:\s]+$/, '');
      continue;
    }

    // Attorney name
    if (/^(Atty|Attorney)\s*:\s*/i.test(line)) {
      result.attorneyName = cleanValue(line.replace(/^(Atty|Attorney)\s*:\s*/i, ''));
      continue;
    }

    // Firm
    if (/^Firm\s*:\s*/i.test(line)) {
      result.firmName = cleanValue(line.replace(/^Firm\s*:\s*/i, ''));
      continue;
    }

    // Email for attorney (before Para section)
    if (/^(Email|E)\s*:\s*/i.test(line) && !result.paraName && !isPastParaSection(lines, i)) {
      const val = cleanValue(line.replace(/^(Email|E)\s*:\s*/i, ''));
      if (val && val.includes('@')) {
        result.email = val.split(/\s/)[0]; // take just the email part
      }
      continue;
    }

    // Phone for attorney
    if (/^(Direct|Tel|T|Phone|O|Main)\s*:\s*/i.test(line) && !result.paraName && !isPastParaSection(lines, i)) {
      const val = cleanValue(line.replace(/^(Direct|Tel|T|Phone|O|Main)\s*:\s*/i, ''));
      if (val && !result.phone) {
        result.phone = val;
      }
      continue;
    }

    // Paralegal
    if (/^Para\s*:\s*/i.test(line)) {
      result.paraName = cleanValue(line.replace(/^Para\s*:\s*/i, ''));
      continue;
    }

    // Para email
    if (/^E\s*:\s*/i.test(line) && result.paraName && !result.paraEmail) {
      const val = cleanValue(line.replace(/^E\s*:\s*/i, ''));
      if (val && val.includes('@')) {
        result.paraEmail = val.split(/\s/)[0];
      }
      continue;
    }

    // Opposing counsel
    if (/^Opposing\s+Counsel\s*:\s*/i.test(line)) {
      result.opposingCounsel = cleanValue(line.replace(/^Opposing\s+Counsel\s*:\s*/i, ''));
      continue;
    }

    // Opposing firm
    if (/^Firm\s*:\s*/i.test(line) && result.opposingCounsel && !result.opposingFirm) {
      result.opposingFirm = cleanValue(line.replace(/^Firm\s*:\s*/i, ''));
      continue;
    }

    // Due date
    if (/^Due\s+Date\s*:\s*/i.test(line)) {
      result.dueDate = cleanValue(line.replace(/^Due\s+Date\s*:\s*/i, ''));
      continue;
    }

    // Fallback: if first non-case-type line has "Esq." and no attorney found yet, treat as attorney
    if (!result.attorneyName && /Esq\.?/i.test(line) && i <= 3) {
      result.attorneyName = cleanValue(line.replace(/,?\s*Esq\.?/i, '').replace(/^(Atty|Attorney)\s*:\s*/i, ''));
      continue;
    }

    // Fallback: standalone email on a line near attorney info
    if (!result.email && /@/.test(line) && i <= 6 && !/^(E|Email|Para)\s*:/i.test(line)) {
      const match = line.match(/[\w.+-]+@[\w.-]+\.\w+/);
      if (match) {
        result.email = match[0];
      }
    }
  }

  // If we got an attorney name with ", Esq." etc, clean it
  if (result.attorneyName) {
    result.attorneyName = result.attorneyName
      .replace(/,?\s*Esq\.?$/i, '')
      .replace(/,?\s*Associate$/i, '')
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

function isPastParaSection(lines, currentIndex) {
  for (let i = 0; i < currentIndex; i++) {
    if (/^Para\s*:/i.test(lines[i])) return true;
  }
  return false;
}

module.exports = { parseNotes };
