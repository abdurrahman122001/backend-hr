// backend/src/controllers/shiftController.js
const Shift = require('../models/Shift');
const Employee = require('../models/Employees');

exports.getShifts = async (req, res) => {
  try {
    const shifts = await Shift.find({ owner: req.user._id }).lean();

    // Ensure graceTime always exists in response (for legacy data)
    const enrichedShifts = shifts.map(shift => ({
      ...shift,
     graceTime: typeof shift.graceTime === "string" ? shift.graceTime : "",
    }));

    res.json(enrichedShifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function addMinutesToTime(time, minutes) {
  // time is a string "HH:mm", minutes is integer
  const [h, m] = time.split(':').map(Number);
  const date = new Date(1970, 0, 1, h, m);
  date.setMinutes(date.getMinutes() + (minutes || 0));
  // Return in "HH:mm" 24-hour format, zero-padded
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// CREATE SHIFT
exports.createShift = async (req, res) => {
  try {
    const { name, timezone, start, end, graceMinutes, isHourly, setHours } = req.body;
    let shiftData = {
      owner: req.user._id,
      name,
      timezone,
      start,
      end,
      isHourly: !!isHourly
    };

    if (isHourly) {
      if (typeof setHours !== 'number' || setHours < 1) {
        return res.status(400).json({ error: 'setHours is required and must be a positive number for hourly shift' });
      }
      shiftData.setHours = setHours;
      shiftData.graceMinutes = undefined;
      shiftData.graceTime = undefined;
    } else {
      if (typeof graceMinutes !== 'number' || graceMinutes < 0) {
        return res.status(400).json({ error: 'graceMinutes is required and must be a number for classic shift' });
      }
      shiftData.graceMinutes = graceMinutes;
      shiftData.graceTime = addMinutesToTime(start, graceMinutes);
      shiftData.setHours = undefined;
    }

    const shift = await Shift.create(shiftData);
    res.status(201).json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// UPDATE SHIFT
exports.updateShift = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, timezone, start, end, graceMinutes, isHourly, setHours } = req.body;
    let update = {
      name, timezone, start, end, isHourly: !!isHourly
    };

    if (isHourly) {
      if (typeof setHours !== 'number' || setHours < 1) {
        return res.status(400).json({ error: 'setHours is required and must be a positive number for hourly shift' });
      }
      update.setHours = setHours;
      update.graceMinutes = undefined;
      update.graceTime = undefined;
    } else {
      if (typeof graceMinutes !== 'number' || graceMinutes < 0) {
        return res.status(400).json({ error: 'graceMinutes is required and must be a number for classic shift' });
      }
      update.graceMinutes = graceMinutes;
      update.graceTime = addMinutesToTime(start, graceMinutes);
      update.setHours = undefined;
    }

    // Update the shift
    const shift = await Shift.findOneAndUpdate(
      { _id: id, owner: req.user._id },
      update,
      { new: true }
    );
    if (!shift) return res.status(404).json({ error: 'Not found' });

    // If shift is classic and graceTime is set, update all employees' rt
    if (!shift.isHourly && shift.graceTime) {
      await Employee.updateMany(
        { shifts: shift._id },
        { $set: { rt: shift.graceTime } }
      );
    }
    res.json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};


exports.deleteShift = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await Shift.deleteOne({ _id: id, owner: req.user._id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.setAllowMultipleShifts = async (req, res) => {
  try {
    const { allowMultipleShifts } = req.body;
    // Save to company/user/org/global settings (adjust model as needed)
    await Shift.updateOne(
      { owner: req.user._id }, // or company/org id
      { $set: { allowMultipleShifts: !!allowMultipleShifts } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getAllowMultipleShifts = async (req, res) => {
  try {
    const settings = await Shift.findOne({ owner: req.user._id }); // or company/org id
    res.json({ allowMultipleShifts: !!settings?.allowMultipleShifts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};