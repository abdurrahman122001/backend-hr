const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rolePermissionController');

// Get all pages with all role permissions
router.get('/', ctrl.getAllPages);

// Get all pages with just one role's permissions
router.get('/role/:role', ctrl.getPagesByRole);

// Get a single page's permissions
router.get('/:pageId', ctrl.getPageById);

// Update one permission for a page+role
router.patch('/:pageId/permissions/:role', ctrl.updatePagePermission);

// Create a new page
router.post('/', ctrl.createPage);

module.exports = router;
