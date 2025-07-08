const CompanyProfile = require('../models/CompanyProfile');

// Get company profile
exports.getMyProfile = async (req, res) => {
  try {
    const profile = await CompanyProfile.findOne({ owner: req.user._id });
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile.' });
  }
};
exports.upsertProfile = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const data = { ...req.body, owner: ownerId };

    const profile = await CompanyProfile.findOneAndUpdate(
      { owner: ownerId },
      { $set: data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ profile });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
