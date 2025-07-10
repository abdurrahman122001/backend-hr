const express = require('express');
const router = express.Router();
const userCtrl = require('../controllers/userController');
const rolePermCtrl = require('../controllers/rolePermissionController');

// User management (super-admin only)
router.post('/admin/create-user', userCtrl.createUser);

// Role permissions
router.get('/admin/role-permissions', rolePermCtrl.getAllRolePermissions);
router.post('/admin/role-permissions/:role', rolePermCtrl.setRolePages);
router.get(
  '/admin/role-permissions/:role',
  rolePermCtrl.getRolePages
);

// Pages list
router.get('/admin/pages', rolePermCtrl.getAllPages);

module.exports = router;
