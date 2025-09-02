// backend/src/controllers/empAuthController.js
const Employee = require('../models/Employees');

// /api/emp-auth/me
exports.getMe = async (req, res) => {
  try {
    // Pull explicit fields incl. owner so FE can use it without guessing
    const emp = await Employee.findById(req.employee._id)
      .select('_id name email companyEmail role department designation leaveEntitlement owner joiningDate')
      .lean();

    if (!emp) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Derive leave numbers safely
    const total      = emp.leaveEntitlement?.total ?? 0;
    const usedPaid   = emp.leaveEntitlement?.usedPaid ?? 0;
    const usedUnpaid = emp.leaveEntitlement?.usedUnpaid ?? 0;

    // Normalize owner to a string id (ObjectId -> string) for the FE
    const ownerId = typeof emp.owner === 'object' && emp.owner !== null && emp.owner._id
      ? String(emp.owner._id)
      : (emp.owner ? String(emp.owner) : null);

    return res.json({
      id: String(emp._id),
      owner: ownerId,                 // <= INCLUDED for the frontend
      name: emp.name || '',
      email: emp.email || '',
      companyEmail: emp.companyEmail || '',
      role: emp.role || '',
      department: emp.department || '',
      designation: emp.designation || '',
      joiningDate: emp.joiningDate || '',
      leaveEntitlement: {
        total,
        usedPaid,
        usedUnpaid,
        leftPaid: Math.max(0, total - usedPaid),
      },
    });
  } catch (err) {
    console.error('getMe error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
