const express = require('express');
const requireAuth = require('../middleware/auth');
const ctrl = require('../controllers/roleHierarchyController');

const router = express.Router();

router.post('/bulkCreate', requireAuth, ctrl.bulkCreate);
router.get('/', requireAuth, ctrl.getHierarchy);

module.exports = router;
