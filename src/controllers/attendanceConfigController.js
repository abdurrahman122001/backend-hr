const AttendanceConfig = require("../models/AttendanceConfig");
const mongoose = require('mongoose');                // <-- add this

const DEFAULT = {
  markAbsentManually: false,
  allowDeleteRecords: false,
  allowEditRecords: false,
  attendanceMode: "auth_login",
  editRecordsScope: "current",
  editPreviousDaysLimit: 7,
  deleteRecordsScope: "current", // NEW
  deletePreviousDaysLimit: 7, // NEW
};

exports.getConfig = async (req, res, next) => {
  try {
    const ownerId = req.user.owner || req.user.createdBy || req.user._id;

    let cfg = await AttendanceConfig.findOne({
      owner: new mongoose.Types.ObjectId(ownerId),
    }).lean();
    if (!cfg) {
      // no doc → just return defaults
      return res.json(DEFAULT);
    }
    // merge any missing keys (in case you add new fields later)
    cfg = Object.assign({}, DEFAULT, cfg);
    res.json(cfg);
  } catch (err) {
    next(err);
  }
};

exports.updateConfig = async (req, res, next) => {
  try {
    const {
      markAbsentManually,
      allowDeleteRecords,
      allowEditRecords,
      attendanceMode,
      editRecordsScope,
      editPreviousDaysLimit, // NEW
      deleteRecordsScope, // NEW
      deletePreviousDaysLimit, // NEW
    } = req.body;

    // Resolve actual tenant/owner id; fall back sensibly for legacy data
    const ownerId = req.user.owner || req.user.createdBy || req.user._id;
    const userId = req.user._id;

    // Convert to ObjectId for proper MongoDB querying
    const ownerOid = new mongoose.Types.ObjectId(ownerId);
    const userOid = new mongoose.Types.ObjectId(userId);

    // Since owner field has unique constraint, just match by owner
    // This ensures upsert doesn't violate the uniqueness constraint
    const filter = {
      owner: ownerOid,
    };

    // Optional: coerce numeric limits safely if provided
    const editLimit =
      editPreviousDaysLimit !== undefined
        ? Number(editPreviousDaysLimit)
        : undefined;
    const deleteLimit =
      deletePreviousDaysLimit !== undefined
        ? Number(deletePreviousDaysLimit)
        : undefined;

    const update = {
      $set: {
        owner: ownerOid,
        createdBy: userOid, // record who configured it
        markAbsentManually,
        allowDeleteRecords,
        allowEditRecords,
        attendanceMode,
        editRecordsScope,
        deleteRecordsScope,
        ...(editLimit !== undefined
          ? { editPreviousDaysLimit: editLimit }
          : {}),
        ...(deleteLimit !== undefined
          ? { deletePreviousDaysLimit: deleteLimit }
          : {}),
      },
    };

    const cfg = await AttendanceConfig.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }).lean();

    res.json(cfg);
  } catch (err) {
    next(err);
  }
};
