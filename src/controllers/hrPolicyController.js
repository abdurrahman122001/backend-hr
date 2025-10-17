const HrPolicy = require("../models/HrPolicy");

// 🟢 Create or Update HR Policy for logged-in user
exports.saveOrUpdatePolicy = async (req, res) => {
  try {
    const { title, content } = req.body;
    const owner = req.user?._id; // ✅ get owner id from req.user

    if (!owner) {
      return res.status(401).json({ message: "Unauthorized: user not found in request" });
    }

    // Check if a policy already exists for this user
    let policy = await HrPolicy.findOne({ owner });

    if (policy) {
      policy.title = title;
      policy.content = content;
      await policy.save();

      return res.status(200).json({
        message: "✅ HR Policy updated successfully",
        policy,
      });
    } else {
      const newPolicy = new HrPolicy({ owner, title, content });
      await newPolicy.save();

      return res.status(201).json({
        message: "✅ HR Policy created successfully",
        policy: newPolicy,
      });
    }
  } catch (error) {
    console.error("❌ Error saving HR Policy:", error);
    res.status(500).json({
      message: "Server error while saving HR Policy",
      error: error.message,
    });
  }
};

// 🟡 Get HR Policy for logged-in user
exports.getMyPolicy = async (req, res) => {
  try {
    const owner = req.user?._id; // ✅ from token
    const policy = await HrPolicy.findOne({ owner });

    if (!policy) {
      return res.status(404).json({ message: "No HR policy found for this user" });
    }

    res.status(200).json(policy);
  } catch (error) {
    console.error("❌ Error fetching HR Policy:", error);
    res.status(500).json({
      message: "Server error while fetching HR Policy",
      error: error.message,
    });
  }
};

// 🔴 Delete HR Policy for logged-in user
exports.deleteMyPolicy = async (req, res) => {
  try {
    const owner = req.user?._id; // ✅ from token
    const deleted = await HrPolicy.findOneAndDelete({ owner });

    if (!deleted) {
      return res.status(404).json({ message: "No HR policy found to delete" });
    }

    res.status(200).json({ message: "🗑️ HR Policy deleted successfully" });
  } catch (error) {
    console.error("❌ Error deleting HR Policy:", error);
    res.status(500).json({
      message: "Server error while deleting HR Policy",
      error: error.message,
    });
  }
};
