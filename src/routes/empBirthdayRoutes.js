// empBirthdayRoutes.js 

const express = require('express');
const router = express.Router();
const requireEmployeeAuth = require('../middleware/empAuth');
const dayjs = require('dayjs');
const Employee = require('../models/Employees');

function getNextBirthday(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = dayjs(dateOfBirth);
  const now = dayjs();
  let nextBirthday = dob.year(now.year());
  if (nextBirthday.isBefore(now, 'day')) {
    nextBirthday = nextBirthday.add(1, 'year');
  }
  return nextBirthday;
}

// GET /api/emp-employees/birthdays
router.get('/birthdays', requireEmployeeAuth, async (req, res) => {
  try {
    // Get the logged-in employee’s owner/company
    const emp = await Employee.findById(req.employee._id).select('owner');
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Find all employees in the same company
    const employees = await Employee.find({
      owner: emp.owner,
      dateOfBirth: { $exists: true, $ne: null, $ne: '' }
    }).select('name dateOfBirth photographUrl email');

    const now = dayjs();
    const upcoming = employees
      .map((emp) => {
        const nextBirthday = getNextBirthday(emp.dateOfBirth);
        return nextBirthday
          ? { ...emp.toObject(), nextBirthday }
          : null;
      })
      .filter(Boolean)
      .filter((e) => {
        const days = e.nextBirthday.diff(now, 'day');
        return days >= 0 && days <= 30; // Next 30 days
      })
      .sort((a, b) => a.nextBirthday.diff(b.nextBirthday));

    res.json(upcoming);
  } catch (err) {
    console.error('Error in getUpcomingBirthdaysForEmployee:', err);
    res.status(500).json({ error: 'Could not fetch birthdays: ' + err.message });
  }
});

module.exports = router;