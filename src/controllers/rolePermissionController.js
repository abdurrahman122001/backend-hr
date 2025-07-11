const Page = require('../models/Pages');

// List all pages with permissions for each role
exports.getAllPages = async (req, res) => {
  try {
    const pages = await Page.find({}, '-__v').lean();
    res.json(pages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pages' });
  }
};

// Get all permissions for a given role (e.g., all pages with HR's permission)
exports.getPagesByRole = async (req, res) => {
  const { role } = req.params;
  const ROLES = ['super-admin', 'admin', 'hr', 'employee'];
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  try {
    const pages = await Page.find({}, '-__v').lean();
    // Map: [{pageId, name, permission}]
    const result = pages.map(p => ({
      pageId: p.pageId,
      name: p.name,
      permission: p.permissions?.[role] || 'hidden',
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pages for role' });
  }
};

// Get permissions for a specific page (across all roles)
exports.getPageById = async (req, res) => {
  try {
    const page = await Page.findOne({ pageId: req.params.pageId });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch page' });
  }
};

// Update a permission for a single page and role
exports.updatePagePermission = async (req, res) => {
  const { pageId, role } = req.params;
  const { permission } = req.body;
  const ROLES = ['super-admin', 'admin', 'hr', 'employee'];
  const PERMISSIONS = ['hidden', 'view', 'edit'];
  if (!ROLES.includes(role) || !PERMISSIONS.includes(permission)) {
    return res.status(400).json({ error: 'Invalid role or permission' });
  }
  try {
    const page = await Page.findOne({ pageId });
    if (!page) return res.status(404).json({ error: 'Page not found' });

    page.permissions[role] = permission;
    await page.save();
    res.json({ success: true, permissions: page.permissions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update permission' });
  }
};

// Create a new page
exports.createPage = async (req, res) => {
  try {
    const { name, pageId, permissions } = req.body;
    const page = await Page.create({ name, pageId, permissions });
    res.json(page);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
