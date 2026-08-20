/**
 * The company's seniority ladder.
 *
 * The ladder is DATA, not a constant: each company builds its own rungs on the
 * HRMS Hierarchy page (stored in models/OrgTier), so "five tiers with the CEO
 * on top" is only what a company starts with. Everything below works off a
 * loaded ladder; the list here is the seed for a company that has none yet.
 *
 * A tier says WHAT someone is; the hierarchy links say WHO they report to.
 * They are deliberately separate — two people can share a tier without one
 * reporting to the other — but they constrain each other: a reporting line may
 * only ever run from a lower tier number to a higher one (isValidReportingPair),
 * which is what stops a Team Lead being filed under an Associate.
 *
 * `scope` says how many of each the company has:
 *   "company"    — one band for the whole company, above every department
 *   "department" — one band inside each department
 *
 * A tier is not normally stored on the employee. It comes from their
 * designation, mapped once per department in Department.designationTiers, so a
 * promotion moves someone up the chart by changing their job title and nothing
 * else. Employee.orgTier overrides that for one person.
 */

/** The ladder a company starts with, before anyone edits it. */
const DEFAULT_ORG_TIERS = [
  {
    tier: 1,
    key: 'ceo',
    label: 'CEO',
    scope: 'company',
    hint: 'One person for the whole company',
  },
  {
    tier: 2,
    key: 'c-suite',
    label: 'C-Suite',
    scope: 'department',
    hint: 'CFO, CTO, COO — one per department',
  },
  {
    tier: 3,
    key: 'team-lead',
    label: 'Team Lead',
    scope: 'department',
    hint: 'Leads a team inside a department',
  },
  {
    tier: 4,
    key: 'executive',
    label: 'Executive',
    scope: 'department',
    hint: 'Works under a team lead',
  },
  {
    tier: 5,
    key: 'associate',
    label: 'Associate',
    scope: 'department',
    hint: 'Entry level',
  },
];

/**
 * A ceiling on how many rungs one company may have. Not a storage limit — it
 * is what keeps the chart readable and keeps stored tier numbers inside the
 * schema `max` on Employee.orgTier / Department.designationTiers.
 */
const MAX_TIERS = 20;

const TIER_SCOPES = ['company', 'department'];

/** Coerce anything to a usable tier number, or null when it is not one. */
function normalizeTier(value, max = MAX_TIERS) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/** "Team Lead" -> "team-lead". A key is an identity, generated once. */
function slugifyTierKey(label) {
  return (
    String(label || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tier'
  );
}

/** Make `base` unique against the keys already in use. */
function uniqueTierKey(base, taken) {
  const root = slugifyTierKey(base);
  if (!taken.has(root)) return root;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${root}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}

/**
 * A first guess at which RUNG a designation belongs on, from its name. Returns
 * one of the default keys — never a number, because tier numbers now depend on
 * the company's own ladder. makeLadder().guess() turns it into a position.
 *
 * Only ever a default; the admin's saved mapping always wins.
 */
function guessTierKeyFromDesignation(name) {
  const text = String(name || '').toLowerCase().trim();
  if (!text) return null;

  // "CEO", "Chief Executive Officer", "Founder & CEO"
  if (/\bceo\b/.test(text) || /chief\s+executive/.test(text)) return 'ceo';

  // Any other C-level: CTO / CFO / COO / CIO / CMO, or "Chief <x> Officer".
  if (/\bc[a-z]o\b/.test(text) || /\bchief\b/.test(text)) return 'c-suite';
  // Department heads sit in the same band as the C-suite.
  if (/\b(head|director|vp|vice\s+president)\b/.test(text)) return 'c-suite';

  if (/\b(lead|manager|supervisor|principal)\b/.test(text)) return 'team-lead';

  // Checked BEFORE the executive titles: "Associate Engineer" is an associate,
  // and the broader word (engineer) would otherwise win.
  if (/\b(associate|assistant|intern|trainee|junior|jr)\b/.test(text))
    return 'associate';

  if (/\b(executive|engineer|developer|analyst|officer|specialist)\b/.test(text))
    return 'executive';

  return null;
}

/**
 * Wrap a company's rungs in the lookups the rest of the code wants. Pass the
 * OrgTier documents (in any order); pass nothing to get the default ladder,
 * which is the fallback for read-only callers.
 */
function makeLadder(tiers) {
  const source =
    Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_ORG_TIERS;

  const list = source
    .map((t) => ({
      id: t._id ? String(t._id) : null,
      tier: Number(t.tier),
      key: String(t.key || ''),
      label: String(t.label || ''),
      hint: String(t.hint || ''),
      scope: TIER_SCOPES.includes(t.scope) ? t.scope : 'department',
    }))
    .filter((t) => Number.isInteger(t.tier) && t.tier >= 1)
    .sort((a, b) => a.tier - b.tier);

  const byTier = new Map(list.map((t) => [t.tier, t]));
  const byKey = new Map(list.map((t) => [t.key, t]));
  const byLabel = new Map(list.map((t) => [t.label.toLowerCase(), t]));
  const max = list.length ? list[list.length - 1].tier : 0;

  return {
    list,
    max,
    byTier,
    byKey,
    companyTiers: list.filter((t) => t.scope === 'company'),
    departmentTiers: list.filter((t) => t.scope === 'department'),

    /** Is this a rung the company actually has? */
    has: (value) => byTier.has(normalizeTier(value, max)),

    /** Coerce to one of THIS ladder's rungs, or null. */
    normalize: (value) => {
      const n = normalizeTier(value, max);
      return n && byTier.has(n) ? n : null;
    },

    meta: (value) => byTier.get(normalizeTier(value, max)) || null,

    label: (value) =>
      byTier.get(normalizeTier(value, max))?.label || 'Unassigned',

    /**
     * Designation -> rung, for titles nobody has mapped yet. Matches on the
     * guessed key first, then on the rung's own name, so a renamed default
     * still catches. A company that built its rungs from scratch gets null and
     * places people by hand, which is the honest answer rather than a guess
     * from a ladder that no longer means what it used to.
     */
    guess: (designation) => {
      const key = guessTierKeyFromDesignation(designation);
      if (!key) return null;
      const hit = byKey.get(key) || byLabel.get(key.replace(/-/g, ' '));
      return hit ? hit.tier : null;
    },
  };
}

/**
 * May `seniorTier` have `juniorTier` reporting to them? Unknown tiers never
 * block a link — half-configured ladders must stay usable — so this only
 * answers false when both tiers are known and the pair inverts the ladder.
 */
function isValidReportingPair(seniorTier, juniorTier) {
  const s = Number(seniorTier);
  const j = Number(juniorTier);
  if (!Number.isInteger(s) || !Number.isInteger(j)) return true;
  return s < j;
}

module.exports = {
  DEFAULT_ORG_TIERS,
  MAX_TIERS,
  TIER_SCOPES,
  normalizeTier,
  slugifyTierKey,
  uniqueTierKey,
  guessTierKeyFromDesignation,
  makeLadder,
  isValidReportingPair,
};
