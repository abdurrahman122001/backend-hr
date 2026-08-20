const mongoose = require("mongoose");
const CallLog = require("../models/CallLog");

const isObjId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

/**
 * Call history for the signed-in employee — calls they placed and calls they
 * received, newest first. Pass `withEmployeeId` to narrow it to the history
 * with one person (what the chat header shows).
 */
exports.getCallHistory = async (req, res) => {
  try {
    const meId = req.employee?._id;
    if (!meId) return res.status(401).json({ error: "Not authenticated" });

    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    // Only ever my own calls — never another pair's.
    const query = {
      $or: [{ caller: meId }, { callee: meId }],
      hiddenFor: { $ne: meId },
    };

    const withEmployeeId = req.query.withEmployeeId;
    if (withEmployeeId) {
      if (!isObjId(withEmployeeId)) {
        return res.status(400).json({ error: "Invalid withEmployeeId" });
      }
      query.$or = [
        { caller: meId, callee: withEmployeeId },
        { caller: withEmployeeId, callee: meId },
      ];
    }

    const [items, total] = await Promise.all([
      CallLog.find(query)
        .sort({ startedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("caller", "_id name photographUrl designation")
        .populate("callee", "_id name photographUrl designation")
        .lean(),
      CallLog.countDocuments(query),
    ]);

    res.json({
      items: items.map((log) => ({
        ...log,
        // Saves every client re-deriving this from the id comparison.
        direction: String(log.caller?._id) === String(meId) ? "outgoing" : "incoming",
      })),
      total,
      page,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error("getCallHistory error:", err);
    res.status(500).json({ error: "Failed to load call history" });
  }
};

/** Badge count: calls I never picked up. */
exports.getMissedCount = async (req, res) => {
  try {
    const meId = req.employee?._id;
    if (!meId) return res.status(401).json({ error: "Not authenticated" });

    const count = await CallLog.countDocuments({
      callee: meId,
      status: { $in: ["missed", "cancelled"] },
      seenByCallee: { $ne: true },
      hiddenFor: { $ne: meId },
    });
    res.json({ count });
  } catch (err) {
    console.error("getMissedCount error:", err);
    res.status(500).json({ error: "Failed to count missed calls" });
  }
};

/** Clear the missed badge once the history has been opened. */
exports.markMissedSeen = async (req, res) => {
  try {
    const meId = req.employee?._id;
    if (!meId) return res.status(401).json({ error: "Not authenticated" });

    await CallLog.updateMany(
      { callee: meId, status: { $in: ["missed", "cancelled"] }, seenByCallee: { $ne: true } },
      { $set: { seenByCallee: true } },
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("markMissedSeen error:", err);
    res.status(500).json({ error: "Failed to update call history" });
  }
};

/**
 * Hide all existing calls from the signed-in employee's history only.
 * The shared call rows remain in the database and stay visible to the other
 * participant. Calls placed after this request are visible as normal.
 */
exports.clearCallHistory = async (req, res) => {
  try {
    const meId = req.employee?._id;
    if (!meId) return res.status(401).json({ error: "Not authenticated" });

    const result = await CallLog.updateMany(
      {
        $or: [{ caller: meId }, { callee: meId }],
        hiddenFor: { $ne: meId },
      },
      {
        $addToSet: { hiddenFor: meId },
      },
    );

    res.json({ ok: true, cleared: result.modifiedCount || 0 });
  } catch (err) {
    console.error("clearCallHistory error:", err);
    res.status(500).json({ error: "Failed to clear call history" });
  }
};
