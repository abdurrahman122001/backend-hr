const Department = require('../models/Departments');
const OrgTier = require('../models/OrgTier');
const { makeLadder } = require('../lib/orgTiers');

/**
 * Accept only { name, tier } pairs THIS COMPANY'S ladder recognises, and only
 * for designations the department actually has. Returns null when the client
 * did not send the field at all, so an untouched department keeps what it had.
 *
 * Validated against the company's own rungs rather than a fixed 1..5 range:
 * the ladder is data now (models/OrgTier), so a tier number that is merely
 * plausible is not necessarily a rung that exists — and a mapping to a rung
 * that does not exist would silently read back as "no tier".
 */
async function sanitizeDesignationTiers(raw, designations, ownerId) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return [];

  const ladder = makeLadder(
    ownerId ? await OrgTier.find({ owner: ownerId }).sort({ tier: 1 }).lean() : []
  );
  const allowed = new Set((designations || []).map((d) => String(d).trim()));
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const name = String(entry?.name || '').trim();
    const tier = ladder.normalize(entry?.tier);
    if (!name || !tier) continue;
    if (allowed.size && !allowed.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, tier });
  }
  return out;
}

// GET all departments for an owner
exports.getDepartments = async (req, res) => {
  try {
    const ownerId = req.user?._id || req.query.owner; // fallback for testing
    if (!ownerId) return res.status(400).json({ error: "Owner required" });
    const departments = await Department.find({ owner: ownerId }).sort({ order: 1 });
    res.json(departments);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get departments.' });
  }
};

// CREATE a new department
exports.createDepartment = async (req, res) => {
  try {
    const owner = req.user?._id || req.body.owner;
    const { name, designations, designationTiers } = req.body;
    if (!name || !owner) {
      return res.status(400).json({ error: 'Name and owner are required.' });
    }
    // Validate designations (optional, must be array of strings if provided)
    if (designations && (!Array.isArray(designations) || designations.some(d => typeof d !== 'string'))) {
      return res.status(400).json({ error: 'Designations must be an array of strings.' });
    }
    const department = new Department({
      name,
      owner,
      designations: designations || [],
      designationTiers:
        (await sanitizeDesignationTiers(designationTiers, designations, owner)) ||
        [],
    });
    await department.save();
    res.status(201).json(department);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Department with this name already exists for this owner.' });
    }
    res.status(500).json({ error: 'Failed to create department.' });
  }
};

// UPDATE a department
exports.updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, designations, designationTiers } = req.body;
    const department = await Department.findById(id);
    if (!department) return res.status(404).json({ error: 'Department not found.' });
    // Update fields if provided
    if (name) department.name = name;
    if (designations) {
      if (!Array.isArray(designations) || designations.some(d => typeof d !== 'string')) {
        return res.status(400).json({ error: 'Designations must be an array of strings.' });
      }
      department.designations = designations;
    }
    const tiers = await sanitizeDesignationTiers(
      designationTiers,
      designations || department.designations,
      department.owner
    );
    if (tiers) department.designationTiers = tiers;
    else if (designations) {
      // The list changed but no tiers came with it — drop mappings for
      // designations that no longer exist rather than leave them orphaned.
      const kept = new Set(designations.map((d) => String(d).trim()));
      department.designationTiers = (department.designationTiers || []).filter(
        (t) => kept.has(String(t.name).trim())
      );
    }
    try {
      await department.save();
      res.json(department);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Department with this name already exists for this owner.' });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to update department.' });
  }
};

// DELETE a department
exports.deleteDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const department = await Department.findByIdAndDelete(id);
    if (!department) {
      return res.status(404).json({ error: 'Department not found.' });
    }
    res.json({ message: 'Department deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete department.' });
  }
};

// BULK UPDATE departments order
exports.reorderDepartments = async (req, res) => {
  try {
    const { departments } = req.body; // [{ _id, order }]
    if (!departments || !Array.isArray(departments)) {
      return res.status(400).json({ error: 'Departments array required.' });
    }
    const bulkOps = departments.map(dep => ({
      updateOne: {
        filter: { _id: dep._id },
        update: { $set: { order: dep.order } }
      }
    }));
    await Department.bulkWrite(bulkOps);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reorder departments.' });
  }
};
