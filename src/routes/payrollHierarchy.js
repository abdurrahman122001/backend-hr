const express = require('express');
const controller = require('../controllers/payrollHierarchyController');

const router = express.Router();

router.get('/', controller.getHierarchy);
router.post('/create', controller.create);
router.post('/bulkCreate', controller.bulkCreate);
router.get('/:employeeId/managementChain', controller.getManagementChain);
router.delete('/:id', controller.deleteHierarchy);

module.exports = router;
