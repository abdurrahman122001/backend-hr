const LeaveRecord = require("../models/LeaveRecord");

// GET
exports.getMyLeaveRecord = async (req, res) => {
  try {
    const owner = req.user._id;
    let record = await LeaveRecord.findOne({ owner });
    return res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST (Create)
exports.createMyLeaveRecord = async (req, res) => {
  try {
    const owner = req.user._id;
    const { asBreakup, breakups, totalEntitled, totalAvailedYTD, totalAvailedFTM, totalBalance } = req.body;

    let doc = await LeaveRecord.findOne({ owner });
    if (doc) return res.status(400).json({ success: false, error: "Record already exists. Use PUT to update." });

    let newRecord;
    if (asBreakup) {
      // fill with zeros for missing keys
      const breakupsClean = (breakups || []).map(b => ({
        type: b.type,
        entitled: Number(b.entitled) || 0,
        availedYTD: 0,
        availedFTM: 0,
        balance: Number(b.entitled) || 0,
      }));
      newRecord = new LeaveRecord({ owner, asBreakup: true, breakups: breakupsClean });
    } else {
      newRecord = new LeaveRecord({
        owner,
        asBreakup: false,
        totalEntitled: Number(totalEntitled) || 0,
        totalAvailedYTD: Number(totalAvailedYTD) || 0,
        totalAvailedFTM: Number(totalAvailedFTM) || 0,
        totalBalance: Number(totalBalance) || Number(totalEntitled) || 0,
      });
    }
    await newRecord.save();
    res.json({ success: true, data: newRecord });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

// PUT (Update)
exports.updateMyLeaveRecord = async (req, res) => {
  try {
    const owner = req.user._id;
    const { asBreakup, breakups, totalEntitled, totalAvailedYTD, totalAvailedFTM, totalBalance } = req.body;

    let update = { asBreakup: !!asBreakup };
    if (asBreakup) {
      update.breakups = (breakups || []).map(b => ({
        type: b.type,
        entitled: Number(b.entitled) || 0,
        availedYTD: 0,
        availedFTM: 0,
        balance: Number(b.entitled) || 0,
      }));
      update.totalEntitled = 0;
      update.totalAvailedYTD = 0;
      update.totalAvailedFTM = 0;
      update.totalBalance = 0;
    } else {
      update.breakups = [];
      update.totalEntitled = Number(totalEntitled) || 0;
      update.totalAvailedYTD = Number(totalAvailedYTD) || 0;
      update.totalAvailedFTM = Number(totalAvailedFTM) || 0;
      update.totalBalance = Number(totalBalance) || Number(totalEntitled) || 0;
    }

    const updated = await LeaveRecord.findOneAndUpdate(
      { owner },
      { $set: update },
      { new: true, upsert: false }
    );
    if (!updated) return res.status(404).json({ success: false, error: "No record found to update. Use POST to insert first." });

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};
// Helper: Pro-rate annual leave if joining date is in the current year
function calculateAnnualEntitled(joiningDate, year, standardEntitled = 14) {
  if (!joiningDate) return standardEntitled;
  const join = new Date(joiningDate);
  if (join.getFullYear() === year) {
    // Joined during the year: get remaining months (inclusive)
    return Math.round((standardEntitled / 12) * (12 - join.getMonth()));
  }
  return standardEntitled;
}

// Helper: Count leave days availed by type from attendance (replace as needed)
async function countAvailedLeaves(userId, type, year) {
  // Example: If you track attendances as {date, employee, leaveType}
  // and only count status === "approved"
  const start = new Date(`${year}-01-01`);
  const end = new Date(`${year}-12-31`);
  return Attendance.countDocuments({
    employee: userId,
    leaveType: type,
    status: "approved",
    date: { $gte: start, $lte: end },
  });
}

exports.getMyLeaveRecord = async (req, res) => {
  try {
    const owner = req.user._id;
    const user = await User.findById(owner);
    const currentYear = new Date().getFullYear();

    // Calculate entitled dynamically
    const entitledAnnual = calculateAnnualEntitled(user?.joiningDate, currentYear);

    // Calculate availed for each leave type
    const types = [
      { type: "Casual", entitled: 8 },
      { type: "Sick", entitled: 8 },
      { type: "Annual", entitled: entitledAnnual },
      { type: "WOP", entitled: 0 },
      { type: "Other", entitled: 0 },
    ];

    let totalEntitled = 0;
    let totalAvailed = 0;
    let breakups = [];

    for (let t of types) {
      const availed = await countAvailedLeaves(owner, t.type, currentYear);
      breakups.push({
        type: t.type,
        entitled: t.entitled,
        availedYTD: availed,
        availedFTM: 0, // Set if you want to count for this month (optional)
        balance: t.entitled - availed,
      });
      totalEntitled += t.entitled;
      totalAvailed += availed;
    }

    const totalBalance = totalEntitled - totalAvailed;

    res.json({
      success: true,
      data: {
        owner,
        year: currentYear,
        asBreakup: true,
        breakups,
        totalEntitled,
        totalAvailedYTD: totalAvailed,
        totalBalance,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
};

exports.getMyTotalEntitled = async (req, res) => {
  try {
    const owner = req.user._id;
    // Only select the totalEntitled field from the document
    const record = await LeaveRecord.findOne({ owner }).select("totalEntitled");
    if (!record) {
      return res.status(404).json({ success: false, error: "No record found" });
    }
    return res.json({
      success: true,
      totalEntitled: record.totalEntitled
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};