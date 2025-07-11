// src/routes/decryptionKeys.js
const express   = require('express');
const bcrypt    = require('bcryptjs');
const requireAuth = require('../middleware/auth');
const DecryptionKey = require('../models/DecryptionKey');
const router    = express.Router();

// Add a new PIN + AES key
// routes/decryptionKeys.js
router.post('/add', requireAuth, async (req, res) => {
  const { key, aesKey, label } = req.body;
  if (!key || !aesKey || aesKey.length !== 32) {
    return res.status(400).json({
      error: 'Both PIN and a 32-char aesKey are required.'
    });
  }
  const hash = await bcrypt.hash(key, 10);
  const isFirst = (await DecryptionKey.countDocuments({ owner: req.user._id })) === 0;
  const newKey = await DecryptionKey.create({
    owner:   req.user._id,
    hash,
    aesKey,             // ← store it here
    label,
    active:  isFirst,   // first one becomes active
    createdBy: req.user._id,
  });
  res.json({ success: true,
    key: { _id: newKey._id, label: newKey.label, active: newKey.active }
  });
});
// List keys (no secrets or hashes)
router.get('/list', requireAuth, async (req, res) => {
  const keys = await DecryptionKey.find({ owner: req.user._id })
    .select('_id label active createdAt')
    .sort({ createdAt: -1 });
  res.json({ success: true, keys });
});

// Activate one key
router.post('/activate/:id', requireAuth, async (req, res) => {
  await DecryptionKey.updateMany({ owner: req.user._id }, { active: false });
  await DecryptionKey.findByIdAndUpdate(req.params.id, { active: true });
  res.json({ success: true });
});

// Delete a key
router.delete('/:id', requireAuth, async (req, res) => {
  await DecryptionKey.deleteOne({ _id: req.params.id, owner: req.user._id });
  res.json({ success: true });
});

// Verify a PIN against any stored hash
router.post('/verify', requireAuth, async (req, res) => {
  const { key } = req.body;
  const keys = await DecryptionKey.find({ owner: req.user._id });
  let match = false, keyId = null;
  for (const k of keys) {
    if (await bcrypt.compare(key, k.hash)) {
      match = true;
      keyId = k._id;
      break;
    }
  }
  res.json({ success: match, keyId });
});

module.exports = router;
