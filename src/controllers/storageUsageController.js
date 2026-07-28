const { getStorageUsage } = require("../services/storageUsageService");

exports.getStorageUsage = async (req, res) => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({
      message: "Admin access is required to view storage usage.",
    });
  }

  try {
    const ownerId = req.user.owner || req.user._id;
    const forceRefresh = req.query.refresh === "1";
    const usage = await getStorageUsage(
      ownerId,
      req.user.role,
      forceRefresh,
    );

    res.setHeader("Cache-Control", "no-store");
    return res.json(usage);
  } catch (error) {
    console.error("[storage-usage] Failed to calculate storage usage:", error);
    return res.status(500).json({
      message: "Unable to calculate storage usage right now.",
    });
  }
};
