const express = require('express');
const ctrl = require('../controllers/orgHierarchyController');

const router = express.Router();

router.post('/create', ctrl.create);
router.post('/bulkCreate', ctrl.bulkCreate);

// The seniority ladder itself. Declared BEFORE the /:employeeId routes so a
// tier id is never mistaken for an employee id.
router.get('/tiers', ctrl.listTiers);
router.post('/tiers', ctrl.createTier);
router.patch('/tiers/reorder', ctrl.reorderTiers);
router.patch('/tiers/:tierId', ctrl.updateTier);
router.delete('/tiers/:tierId', ctrl.deleteTier);

router.get('/', ctrl.getHierarchy);
// Seniors (employees that already have juniors) — optionally scoped to a department
router.get('/seniors', ctrl.getSeniors);
router.get('/:employeeId/directReports', ctrl.getDirectReports);
router.get('/:employeeId/managementChain', ctrl.getManagementChain);

// Move one person to another rung without touching their job title.
router.patch('/:employeeId/tier', ctrl.setEmployeeTier);

router.delete('/:id', ctrl.deleteHierarchy);

module.exports = router;
