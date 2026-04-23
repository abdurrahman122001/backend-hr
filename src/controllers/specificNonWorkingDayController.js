// src/controllers/specificNonWorkingDayController.js

const SpecificNonWorkingDay = require("../models/SpecificNonWorkingDay");
const mongoose = require("mongoose");

function resolveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id;
}

exports.getSpecificNonWorkingDays = async (req, res, next) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const { from, to } = req.query;

    const filter = {
      owner: new mongoose.Types.ObjectId(ownerId),
    };

    if (from && to) {
      filter.date = {
        $gte: from,
        $lte: to,
      };
    }

    const days = await SpecificNonWorkingDay.find(filter)
      .sort({ date: 1 })
      .lean();

    res.json(days);
  } catch (err) {
    next(err);
  }
};

exports.getSpecificNonWorkingDaysByDate = async (req, res, next) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: "Date is required" });
    }

    const day = await SpecificNonWorkingDay.findOne({
      owner: new mongoose.Types.ObjectId(ownerId),
      date,
    }).lean();

    res.json(day || null);
  } catch (err) {
    next(err);
  }
};

exports.createSpecificNonWorkingDay = async (req, res, next) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const { date, reason } = req.body;

    if (!date) {
      return res.status(400).json({ error: "Date is required" });
    }

    const ownerOid = new mongoose.Types.ObjectId(ownerId);

    // Upsert: create or update if already exists
    const day = await SpecificNonWorkingDay.findOneAndUpdate(
      {
        owner: ownerOid,
        date,
      },
      {
        $set: {
          owner: ownerOid,
          date,
          reason: reason || null,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    res.json(day);
  } catch (err) {
    next(err);
  }
};

exports.deleteSpecificNonWorkingDay = async (req, res, next) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const date = req.body.date || req.query.date;

    if (!date) {
      return res.status(400).json({ error: "Date is required" });
    }

    const ownerOid = new mongoose.Types.ObjectId(ownerId);

    const result = await SpecificNonWorkingDay.deleteOne({
      owner: ownerOid,
      date,
    });

    res.json({
      success: result.deletedCount > 0,
      message:
        result.deletedCount > 0
          ? "Specific non-working day removed"
          : "Not found",
    });
  } catch (err) {
    next(err);
  }
};
