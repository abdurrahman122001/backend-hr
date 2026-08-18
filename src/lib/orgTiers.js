/**
 * The company's seniority ladder.
 *
 * Five fixed tiers, top first. A tier says WHAT someone is; the hierarchy links
 * say WHO they report to. They are deliberately separate — two people can share
 * a tier without one reporting to the other — but they constrain each other:
 * a reporting line may only ever run from a lower tier number to a higher one
 * (see isValidReportingPair), which is what stops a Team Lead being filed under
 * an Associate.
 *
 * `scope` says how many of each the company has:
 *   "company"    — one for the whole company, sitting above every department
 *   "department" — one band per department
 *
 * A tier is NOT stored on the employee. It comes from their designation, mapped
 * once per department in Department.designationTiers, so a promotion moves
 * someone up the chart by changing their job title and nothing else.
 */

const ORG_TIERS = [
  {
    tier: 1,
    key: "ceo",
    label: "CEO",
    scope: "company",
    hint: "One person for the whole company",
  },
  {
    tier: 2,
    key: "c-suite",
    label: "C-Suite",
    scope: "department",
    hint: "CFO, CTO, COO — one per department",
  },
  {
    tier: 3,
    key: "team-lead",
    label: "Team Lead",
    scope: "department",
    hint: "Leads a team inside a department",
  },
  {
    tier: 4,
    key: "executive",
    label: "Executive",
    scope: "department",
    hint: "Works under a team lead",
  },
  {
    tier: 5,
    key: "associate",
    label: "Associate",
    scope: "department",
    hint: "Entry level",
  },
];

const MIN_TIER = 1;
const MAX_TIER = ORG_TIERS.length;

const TIER_BY_NUMBER = new Map(ORG_TIERS.map((t) => [t.tier, t]));

/** Coerce anything to a valid tier number, or null when it is not one. */
function normalizeTier(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_TIER || n > MAX_TIER) return null;
  return n;
}

function tierMeta(value) {
  const n = normalizeTier(value);
  return n ? TIER_BY_NUMBER.get(n) : null;
}

function tierLabel(value) {
  return tierMeta(value)?.label || "Unassigned";
}

/**
 * A first guess at a designation's tier from its name, used to seed the map so
 * an existing company is not staring at a blank ladder. Only ever a default —
 * the admin's saved choice always wins.
 */
function guessTierFromDesignation(name) {
  const text = String(name || "").toLowerCase().trim();
  if (!text) return null;

  // "CEO", "Chief Executive Officer", "Founder & CEO"
  if (/\bceo\b/.test(text) || /chief\s+executive/.test(text)) return 1;

  // Any other C-level: CTO / CFO / COO / CIO / CMO, or "Chief <x> Officer".
  if (/\bc[a-z]o\b/.test(text) || /\bchief\b/.test(text)) return 2;
  // Department heads sit in the same band as the C-suite.
  if (/\b(head|director|vp|vice\s+president)\b/.test(text)) return 2;

  if (/\b(lead|manager|supervisor|principal)\b/.test(text)) return 3;

  // Checked BEFORE the tier-4 titles: "Associate Engineer" is an associate,
  // and the broader word (engineer) would otherwise win.
  if (/\b(associate|assistant|intern|trainee|junior|jr)\b/.test(text)) return 5;

  if (/\b(executive|engineer|developer|analyst|officer|specialist)\b/.test(text))
    return 4;

  return null;
}

/**
 * May `seniorTier` have `juniorTier` reporting to them? Unknown tiers never
 * block a link — half-configured ladders must stay usable — so this only
 * answers false when both tiers are known and the pair inverts the ladder.
 */
function isValidReportingPair(seniorTier, juniorTier) {
  const s = normalizeTier(seniorTier);
  const j = normalizeTier(juniorTier);
  if (!s || !j) return true;
  return s < j;
}

module.exports = {
  ORG_TIERS,
  MIN_TIER,
  MAX_TIER,
  normalizeTier,
  tierMeta,
  tierLabel,
  guessTierFromDesignation,
  isValidReportingPair,
};
