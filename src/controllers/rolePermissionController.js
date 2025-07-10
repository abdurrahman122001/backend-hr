const RolePermission = require('../models/RolePermission');
const Page = require('../models/Pages'); // <- NEW

// Get all role permissions
exports.getAllRolePermissions = async (req, res) => {
  const all = await RolePermission.find();
  res.json(all);
};

// Update a single role's page permissions
exports.setRolePages = async (req, res) => {
  const { role } = req.params;
  const { pages } = req.body;
  if (!role || !pages) return res.status(400).json({ error: 'role & pages required' });

  // Ensure req.user exists, set updatedBy
  const updatedBy = req.user && req.user._id ? req.user._id : null;

  await RolePermission.findOneAndUpdate(
    { role },
    { $set: { pages, updatedBy } },
    { upsert: true, new: true }
  );
  res.json({ success: true });
};

// --- UPDATED: Fetch all pages from the DB, not a static file
exports.getAllPages = async (req, res) => {
  try {
    // Only return pageId and name to frontend
    const pages = await Page.find({}, { _id: 0, pageId: 1, name: 1 });
    res.json(pages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pages' });
  }
};
// Fetch just one role’s pages
exports.getRolePages = async (req, res) => {
  const { role } = req.params;
  if (!role) return res.status(400).json({ error: 'role required' });

  const doc = await RolePermission.findOne({ role }).lean();
  res.json({
    role,
    pages: doc?.pages || []
  });
};