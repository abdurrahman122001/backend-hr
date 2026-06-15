const CompanyProfile = require('../models/CompanyProfile');
const { ensureCompanyOwnerIndex } = require('../utils/companyEmployeeId');

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
    let data;
    
    // When sending FormData, the frontend passes JSON as a string in req.body.data
    if (req.body.data) {
      try {
        data = typeof req.body.data === "string" ? JSON.parse(req.body.data) : req.body.data;
      } catch (e) {
        data = req.body;
      }
    } else {
      data = { ...req.body };
    }
    
    data.owner = ownerId;

    if (req.file) {
      data.logo = `/uploads/${req.file.filename}`;
    }

    // Ensure only one branch can have useForDocumentation set to true
    if (data.branches && data.branches.length > 0) {
      let hasDocumentationBranch = false;
      data.branches = data.branches.map(branch => {
        if (branch.useForDocumentation) {
          if (hasDocumentationBranch) {
            // If we already found one documentation branch, set this to false
            return { ...branch, useForDocumentation: false };
          }
          hasDocumentationBranch = true;
        }
        return branch;
      });
      
      // If no branch is marked for documentation, mark the first one
      if (!hasDocumentationBranch && data.branches.length > 0) {
        data.branches[0].useForDocumentation = true;
      }
    }

    const profile = await CompanyProfile.findOneAndUpdate(
      { owner: ownerId },
      { $set: data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    profile.ownerIndex = await ensureCompanyOwnerIndex(profile);

    res.json({ profile });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
