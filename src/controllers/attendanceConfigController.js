const AttendanceConfig = require("../models/AttendanceConfig");
const mongoose = require('mongoose');                // <-- add this

const DEFAULT = {
  markAbsentManually: false,
  allowDeleteRecords: false,
  allowEditRecords: false,
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
      editRecordsScope,
      editPreviousDaysLimit, // NEW
      deleteRecordsScope, // NEW
      deletePreviousDaysLimit, // NEW
    } = req.body;

    // Resolve actual tenant/owner id; fall back sensibly for legacy data
    const ownerId = req.user.owner || req.user.createdBy || req.user._id;
    const userId = req.user._id;

    // Match either the normalized (owner+createdBy) doc or any legacy owner doc
    const filter = {
      $or: [
        { owner: ownerId, createdBy: userId }, // new normalized record
        { owner: ownerId }, // tenant-scoped legacy
        { owner: userId }, // self-scoped legacy
      ],
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
        owner: ownerId,
        createdBy: userId, // record who configured it
        markAbsentManually,
        allowDeleteRecords,
        allowEditRecords,
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
