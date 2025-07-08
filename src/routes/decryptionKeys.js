// routes/decryptionKeys.js
const express = require('express');
const bcrypt = require('bcryptjs');
const requireAuth = require('../middleware/auth');
const DecryptionKey = require('../models/DecryptionKey');
const router = express.Router();

// Add a new key (hash before storing)
router.post('/add', requireAuth, async (req, res) => {
  try {
    const { key, label } = req.body;
    if (!key) return res.status(400).json({ error: 'Key is required.' });

    const hash = await bcrypt.hash(key, 10);

    // Only first key added is set as active
    const isFirst = (await DecryptionKey.countDocuments({ owner: req.user._id })) === 0;

    const newKey = await DecryptionKey.create({
      owner: req.user._id,
      hash,
      label,
      active: isFirst,
      createdBy: req.user._id,
    });

    res.json({ success: true, key: { _id: newKey._id, label: newKey.label, active: newKey.active } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all keys (do NOT send hashes!)
router.get('/list', requireAuth, async (req, res) => {
  const keys = await DecryptionKey.find({ owner: req.user._id })
    .select('_id label active createdAt')
    .sort({ createdAt: -1 });
  res.json({ success: true, keys });
});

// Activate a key (set one as active, deactivate others)
router.post('/activate/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  await DecryptionKey.updateMany({ owner: req.user._id }, { active: false });
  await DecryptionKey.findByIdAndUpdate(id, { active: true });
  res.json({ success: true });
});

// Delete a key
router.delete('/:id', requireAuth, async (req, res) => {
  await DecryptionKey.deleteOne({ _id: req.params.id, owner: req.user._id });
  res.json({ success: true });
});

// Verify a key (check hash)
router.post('/verify', requireAuth, async (req, res) => {
  const { key } = req.body;
  const keys = await DecryptionKey.find({ owner: req.user._id });
  let match = false, id = null;
  for (const dbKey of keys) {
    if (await bcrypt.compare(key, dbKey.hash)) {
      match = true;
      id = dbKey._id;
      break;
    }
  }
  res.json({ success: match, keyId: id });
});

module.exports = router;
