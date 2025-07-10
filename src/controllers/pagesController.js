// controllers/pagesController.js

const Page = require('../models/Pages');

exports.getPagesPermissionsByRole = async (req, res) => {
  const { role } = req.params;
  if (!role) return res.status(400).json({ error: "Role required" });
  try {
    const pages = await Page.find({});
    // Build permissions lookup: { pageId: permission }
    const pagePermissions = {};
    for (const p of pages) {
      pagePermissions[p.pageId] = p.permissions[role] || "hidden";
    }
    res.json(pagePermissions);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch page permissions" });
  }
};
exports.updatePagePermissionForRole = async (req, res) => {
  const { pageId, role } = req.params;
  const { permission } = req.body;
  if (!pageId || !role || !permission) {
    return res.status(400).json({ error: 'pageId, role, and permission required' });
  }
  if (!["admin","hr","employee"].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (!["view","edit","hidden"].includes(permission)) {
    return res.status(400).json({ error: 'Invalid permission' });
  }
  try {
    await Page.findOneAndUpdate(
      { pageId },
      { $set: { [`permissions.${role}`]: permission } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update permission' });
  }
};