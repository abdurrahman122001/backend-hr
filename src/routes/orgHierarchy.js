const express = require('express');
const ctrl = require('../controllers/orgHierarchyController');

const router = express.Router();

router.post('/create', ctrl.create);
router.post('/bulkCreate', ctrl.bulkCreate);

router.get('/', ctrl.getHierarchy);
router.get('/:employeeId/directReports', ctrl.getDirectReports);
router.get('/:employeeId/managementChain', ctrl.getManagementChain);

router.delete('/:id', ctrl.deleteHierarchy);

module.exports = router;
