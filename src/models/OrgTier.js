const mongoose = require('mongoose');

/**
 * One rung of a company's seniority ladder.
 *
 * The ladder used to be five hard-coded rungs (CEO → C-Suite → Team Lead →
 * Executive → Associate) in lib/orgTiers. It is now data: every company builds
 * its own, adds rungs where it needs them, renames them and reorders them.
 * The defaults are only a seed for a company that has never touched it.
 *
 *   tier   position on the ladder, 1 = top. Contiguous 1..n, renumbered by the
 *          controller whenever a rung is added, removed or moved — which is
 *          also when Employee.orgTier and Department.designationTiers are
 *          remapped, so nobody silently changes rung.
 *   key    stable slug, assigned once at creation and never rewritten. Renaming
 *          a rung keeps its key so the designation guesser (and anything else
 *          matching by meaning rather than position) keeps working.
 *   scope  "company"    — one band across the whole org, above every department
 *          "department" — one band inside each department
 */
const orgTierSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    tier: { type: Number, required: true, min: 1 },
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    hint: { type: String, default: '', trim: true },
    scope: {
      type: String,
      enum: ['company', 'department'],
      default: 'department',
    },
  },
  { timestamps: true }
);

// Position is rewritten in bulk on every reorder, so it is deliberately NOT
// unique — a unique index would reject the intermediate states of a renumber.
// The key is the identity, and that one is unique.
orgTierSchema.index({ owner: 1, tier: 1 });
orgTierSchema.index({ owner: 1, key: 1 }, { unique: true });

module.exports =
  mongoose.models.OrgTier || mongoose.model('OrgTier', orgTierSchema);
