# Marketing Intelligence Suite — Design Spec

## Overview

Six new features that turn raw Asana/Insightly data into actionable marketing intelligence for Scott Wolstein and the KWVRS team.

---

## Feature 1: Referral Velocity Tracking

**What it does:** Tracks how often each attorney refers cases, detects slowdowns, and alerts Scott before relationships go cold.

**Data source:** Opportunity creation dates in Insightly, grouped by attorney.

**How it works:**
- Calculate average days between referrals for each attorney with 2+ cases
- Compare recent gap to their historical average
- Flag "slowing down" when current gap exceeds 1.5x their average
- Three categories:
  - **Regular** — referring at or above their normal pace
  - **Slowing** — gap is 1.5x-2x their average (yellow alert)
  - **Stalled** — gap exceeds 2x average (red alert)

**Action items generated:**
- "Attorney X usually refers every 6 weeks but it's been 10 weeks — call to check in"

**Where it shows:** Scott's Marketing tab as a new "Slowing Down" filter category.

---

## Feature 2: Geographic Targeting

**What it does:** Parses firm addresses from case notes, maps referral sources by location, identifies geographic gaps.

**Data source:** Address lines in Asana task notes (already present but unparsed).

**Parser additions:**
- Extract `Address:` lines
- Extract city/state from address text (e.g., "New York, NY 10017")
- Fallback: extract state from any line with a state abbreviation + zip pattern

**Report additions:**
- Cases by state (bar chart)
- Top cities (table)
- Geographic gaps: states with attorneys but few referrals vs states with no presence

**Action items generated:**
- "We have 5 attorneys in NJ but only 2 referrals — target NJ marketing"
- "No referrals from CT — consider outreach"

**Where it shows:** New "Geographic" section in Analytics tab + geographic action items in Scott's list.

---

## Feature 3: Opposing Counsel as Leads

**What it does:** Tracks opposing counsel who've appeared in our cases. These attorneys already know KWVRS's work quality from the other side — they're warm leads.

**Data source:** `Opposing Counsel:` and opposing `Firm:` fields already parsed in parser.js but not stored.

**How it works:**
- Store opposing counsel name + firm in a new DB table or Insightly contacts (tagged as "Opposing — Potential Lead")
- Count how many times each opposing counsel has appeared
- Rank by frequency

**Action items generated:**
- "Attorney X has been opposing counsel on 5 cases — they've seen our work. Reach out."
- Include their firm name for context

**Where it shows:** Scott's Marketing tab as new "Opposing Counsel Leads" filter category.

---

## Feature 4: Paralegal Relationship Tracking

**What it does:** Syncs paralegal contacts to Insightly, linked to their attorney. Paralegals often choose which expert to hire.

**Data source:** `Para:`, para email, para phone fields already parsed in parser.js.

**How it works:**
- Create Insightly contacts for paralegals with tag "Paralegal"
- Link to their attorney's contact record
- Link to relevant opportunities

**Report additions:**
- Count of paralegals in network
- Paralegals with email (targetable for outreach)

**Action items generated:**
- "Send holiday cards to top 20 paralegals"
- Paralegal contact list exportable to Excel

**Where it shows:** Added to the email export + new "Paralegals" section in Analytics.

---

## Feature 5: Service Cross-Sell Opportunities

**What it does:** Identifies firms that only refer for some services but not others — opportunities to educate them about our full capabilities.

**Data source:** Service types (VE/LCP/ECON/LHHS) per firm, already parsed.

**How it works:**
- For each firm with 3+ cases, check which services they've referred for
- Compare against our full service list
- Flag gaps: "Firm X sends VE cases but never LCP"
- Prioritize by firm size (bigger firms = bigger opportunity)

**Action items generated:**
- "Firm X has sent 12 VE cases but 0 Life Care Plans — email about LCP services"
- "Firm Y does MAT cases but has never sent Economics work"

**Where it shows:** Scott's Marketing tab as "Cross-Sell Opportunities" filter category.

---

## Feature 6: Case Outcome Tracking

**What it does:** Adds ability to log outcomes on cases (report well-received, led to settlement, etc.) via the Insightly Notes API. Feeds into marketing talking points.

**How it works:**
- New section in the dashboard to log outcomes on completed cases
- Uses Insightly's `POST /Opportunities/{id}/Notes` endpoint
- Tracks: outcome type (settlement, trial, dismissed, pending), satisfaction (positive/neutral/negative), notes
- Aggregates: "Our reports contributed to settlements in X% of cases"

**Report additions:**
- CEO report: overall outcome stats
- Marketing: "X% positive outcomes" as a talking point Scott can use

**Where it shows:** New "Outcomes" section in COO tab + summary stat in CEO tab.

---

## Implementation Order

1. **Parser enhancements** — add address, opposing counsel storage, paralegal phone parsing
2. **Referral velocity** — calculate and add to report
3. **Cross-sell opportunities** — analyze service gaps per firm
4. **Opposing counsel leads** — store and surface
5. **Geographic targeting** — parse addresses, create location charts
6. **Paralegal sync** — create contacts in Insightly
7. **Case outcome tracking** — add notes API integration + UI

## Files Modified

- `src/parser.js` — add address parsing, fix paralegal phone
- `src/report.js` — add velocity, cross-sell, geographic, opposing counsel analytics
- `src/sync.js` — sync paralegals and opposing counsel to Insightly
- `src/insightly.js` — add Notes API, tag contacts
- `src/db.js` — new tables for opposing counsel, velocity cache
- `server.js` — new API endpoints for outcomes
- `public/report.html` — new sections/filters in all tabs
