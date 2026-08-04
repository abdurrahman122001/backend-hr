const { Schema, model } = require('mongoose');

const OrgHierarchySchema = new Schema({
  owner: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  senior: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  junior: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  relation: {
    type: String,
    enum: ['Manager', 'Team Lead', 'Mentor', 'Other'],
    default: 'Manager'
  },

  /* ─── Department scoping ────────────────────────────────────────────────
   * The department a reporting line belongs to — always the JUNIOR's
   * department, because the link is that person's place in their own team.
   *
   * `scope`:
   *   "department" — senior and junior sit in the same department (the normal
   *                  case; the whole chain stays inside one team)
   *   "company"    — a deliberate cross-department line, e.g. a department head
   *                  reporting to the CEO. These are the only links that join
   *                  one department's tree to another's.
   *
   * Both are derived in rebuildHierarchy(), never trusted from the client.
   * ------------------------------------------------------------------- */
  department: {
    type: String,
    default: ''
  },
  scope: {
    type: String,
    enum: ['department', 'company'],
    default: 'department'
  },

  hierarchyLevel: {
    type: Number,
    required: true
  },
  path: {
    type: String,
    required: true
  },
  rootManager: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  }
}, { timestamps: true });

OrgHierarchySchema.index({ owner: 1, senior: 1, junior: 1 }, { unique: true });
OrgHierarchySchema.index({ owner: 1, junior: 1 });
OrgHierarchySchema.index({ owner: 1, path: 1 });
OrgHierarchySchema.index({ owner: 1, rootManager: 1 });
OrgHierarchySchema.index({ owner: 1, hierarchyLevel: 1 });
OrgHierarchySchema.index({ owner: 1, department: 1 });
OrgHierarchySchema.index({ owner: 1, scope: 1 });

module.exports = model('OrgHierarchy', OrgHierarchySchema);
