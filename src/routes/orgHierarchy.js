const express = require('express');
const ctrl = require('../controllers/orgHierarchyController');

const router = express.Router();

router.post('/create', ctrl.create);
router.post('/bulkCreate', ctrl.bulkCreate);

router.get('/', ctrl.getHierarchy);
// Seniors (employees that already have juniors) — optionally scoped to a department
router.get('/seniors', ctrl.getSeniors);
router.get('/:employeeId/directReports', ctrl.getDirectReports);
router.get('/:employeeId/managementChain', ctrl.getManagementChain);

router.delete('/:id', ctrl.deleteHierarchy);

module.exports = router;
