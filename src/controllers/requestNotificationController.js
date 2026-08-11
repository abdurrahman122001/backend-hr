const RequestNotification = require("../models/RequestNotification");

const getRecipientId = (req) =>
  req.employee?._id ||
  req.user?.employeeId ||
  req.user?.employeeInfo?.employeeId;

exports.listNotifications = async (req, res) => {
  try {
    const recipient = getRecipientId(req);
    if (!recipient) return res.status(401).json({ message: "Unauthorized" });

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const [notifications, unreadCount] = await Promise.all([
      RequestNotification.find({ recipient })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("actor", "name email employeeId department designation photographUrl")
        .lean(),
      RequestNotification.countDocuments({ recipient, read: false }),
    ]);

    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error("[RequestNotification] list error:", error);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
};

exports.markNotificationsRead = async (req, res) => {
  try {
    const recipient = getRecipientId(req);
    if (!recipient) return res.status(401).json({ message: "Unauthorized" });

    await RequestNotification.updateMany(
      { recipient, read: false },
      { $set: { read: true, readAt: new Date() } },
    );

    res.json({ unreadCount: 0 });
  } catch (error) {
    console.error("[RequestNotification] mark read error:", error);
    res.status(500).json({ message: "Failed to mark notifications as read" });
  }
};

exports.clearNotifications = async (req, res) => {
  try {
    const recipient = getRecipientId(req);
    if (!recipient) return res.status(401).json({ message: "Unauthorized" });

    const result = await RequestNotification.deleteMany({ recipient });
    res.json({ deletedCount: result.deletedCount || 0, unreadCount: 0 });
  } catch (error) {
    console.error("[RequestNotification] clear error:", error);
    res.status(500).json({ message: "Failed to clear notifications" });
  }
};
