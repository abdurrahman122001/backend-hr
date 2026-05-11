const AttendanceFlag = require("../models/AttendanceFlag");
const Shift = require("../models/Shift");

// GET all attendance flags
exports.getAttendanceFlags = async (req, res) => {
  try {
    const flags = await AttendanceFlag.find({})
      .populate('shift', 'name _id')
      .sort({ createdAt: -1 });
    res.json(flags);
  } catch (error) {
    console.error('Error fetching attendance flags:', error);
    res.status(500).json({ error: 'Failed to fetch attendance flags' });
  }
};

exports.createAttendanceFlag = async (req, res) => {
  try {
    const { flag, shift, fromTime, toTime, hours } = req.body;

    const newFlag = new AttendanceFlag({
      flag: flag || null,
      shift: shift || null,
      fromTime: fromTime || '',
      toTime: toTime || '',
      hours: parseFloat(hours) || 0,
    });

    const savedFlag = await newFlag.save();
    res.status(201).json(savedFlag);
  } catch (error) {
    console.error('Error creating attendance flag:', error);
    res.status(500).json({ error: 'Failed to create attendance flag' });
  }
};
// PUT update attendance flag
exports.updateAttendanceFlag = async (req, res) => {
  try {
    const { id } = req.params;
    const { flag, shift, fromTime, toTime, hours } = req.body;

    // Validate shift exists if provided
    if (shift) {
      const shiftExists = await Shift.findById(shift);
      if (!shiftExists) {
        return res.status(400).json({ error: 'Invalid shift ID' });
      }
    }

    const updatedFlag = await AttendanceFlag.findByIdAndUpdate(
      id,
      { flag, shift, fromTime, toTime, hours: parseFloat(hours) || 0 },
      { new: true, runValidators: true }
    );

    if (!updatedFlag) {
      return res.status(404).json({ error: 'Attendance flag not found' });
    }

    res.json(updatedFlag);
  } catch (error) {
    console.error('Error updating attendance flag:', error);
    res.status(500).json({ error: 'Failed to update attendance flag' });
  }
};

// DELETE attendance flag
exports.deleteAttendanceFlag = async (req, res) => {
  try {
    const { id } = req.params;
    
    const deletedFlag = await AttendanceFlag.findByIdAndDelete(id);
    
    if (!deletedFlag) {
      return res.status(404).json({ error: 'Attendance flag not found' });
    }

    res.json({ message: 'Attendance flag deleted successfully' });
  } catch (error) {
    console.error('Error deleting attendance flag:', error);
    res.status(500).json({ error: 'Failed to delete attendance flag' });
  }
};
