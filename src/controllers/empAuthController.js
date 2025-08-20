// backend/src/controllers/empAuthController.js
const Employee = require('../models/Employees');
const crypto = require('crypto');
// /api/emp-auth/me
exports.getMe = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // optional: compute "leftPaid" here or do it on the FE
    const total     = emp.leaveEntitlement?.total ?? 0;
    const usedPaid  = emp.leaveEntitlement?.usedPaid ?? 0;
    const usedUnpaid= emp.leaveEntitlement?.usedUnpaid ?? 0;

    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
