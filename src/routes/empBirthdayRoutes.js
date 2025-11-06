const express = require('express');
const router = express.Router();
const requireEmployeeAuth = require('../middleware/empAuth');
const dayjs = require('dayjs');
const Employee = require('../models/Employees');
const requireAuth = require('../middleware/auth');

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

function getNextAnniversary(dateOfJoining) {
  if (!dateOfJoining) return null;
  const doj = dayjs(dateOfJoining);
  const now = dayjs();
  let nextAnniversary = doj.year(now.year());
  if (nextAnniversary.isBefore(now, 'day')) {
    nextAnniversary = nextAnniversary.add(1, 'year');
  }
  const yearsOfService = nextAnniversary.year() - doj.year();
  return { nextAnniversary, yearsOfService };
}

// GET /api/emp-birthdays/birthdays
router.get('/birthdays', requireEmployeeAuth, async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select('owner');
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

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
        return days >= 0 && days <= 30;
      })
      .sort((a, b) => a.nextBirthday.diff(b.nextBirthday));

    res.json(upcoming);
  } catch (err) {
    console.error('Error in getUpcomingBirthdaysForEmployee:', err);
    res.status(500).json({ error: 'Could not fetch birthdays: ' + err.message });
  }
});

router.get('/anniversaries', requireAuth, async (req, res) => {
  try {
    // ✅ FIX: Use req.user._id instead of req._id
    const emp = await Employee.findById(req.user._id).select('owner');
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const employees = await Employee.find({
      owner: emp.owner,
      dateOfJoining: { $exists: true, $ne: null, $ne: '' },
    }).select('name dateOfJoining photographUrl email');

    const now = dayjs();
    const upcoming = employees
      .map((e) => {
        const info = getNextAnniversary(e.dateOfJoining);
        if (!info) return null;
        return {
          ...e.toObject(),
          nextAnniversary: info.nextAnniversary,
          yearsOfService: info.yearsOfService,
        };
      })
      .filter(Boolean)
      .filter((e) => {
        const days = e.nextAnniversary.diff(now, 'day');
        return days >= 0 && days <= 7;
      })
      .sort((a, b) => a.nextAnniversary.diff(b.nextAnniversary));

    res.json(upcoming);
  } catch (err) {
    console.error('Error fetching anniversaries:', err);
    res.status(500).json({ error: 'Could not fetch anniversaries: ' + err.message });
  }
});

module.exports = router;