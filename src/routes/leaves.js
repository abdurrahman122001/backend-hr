// backend/src/routes/leaves.js
const router = require('express').Router();
const { requestLeave, listLeaves, decideLeave } = require('../controllers/leavesController');

router.post('/',   requestLeave);       // employee asks for leave
router.get('/',    listLeaves);         // HR sees all requests (filter pending)
router.put('/:id', decideLeave);        // HR approves or rejects

module.exports = router;
