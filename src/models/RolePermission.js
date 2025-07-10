const mongoose = require('mongoose');

// Example page: dashboard, attendance, salary-slip, etc.
const rolePermissionSchema = new mongoose.Schema({
  role:   { type: String, enum: ['super-admin', 'admin', 'hr', 'employee'], required: true, unique: true },
  pages:  [{ type: String }]
});

module.exports = mongoose.model('RolePermission', rolePermissionSchema);
