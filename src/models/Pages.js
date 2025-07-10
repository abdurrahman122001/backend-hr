const mongoose = require('mongoose');

// Define which roles and permissions exist in your system.
const ROLES = ['super-admin', 'admin', 'hr', 'employee'];
const PERMISSIONS = ['hidden', 'view', 'edit'];

// This schema maps each role to a permission level for a page.
const rolePermissionsSchema = new mongoose.Schema(
  ROLES.reduce((acc, role) => {
    acc[role] = {
      type: String,
      enum: PERMISSIONS,
      default: 'hidden', // Default for all roles is 'hidden'
    };
    return acc;
  }, {}),
  { _id: false }
);

// Main Page schema
const pageSchema = new mongoose.Schema({
  name:      { type: String, required: true },            // Human readable name
  pageId:    { type: String, required: true, unique: true }, // URL route or page identifier
  permissions: { type: rolePermissionsSchema, required: true },
});

module.exports = mongoose.model('Page', pageSchema);
