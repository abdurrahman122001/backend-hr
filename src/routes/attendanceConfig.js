const router = require('express').Router();
const { getConfig, updateConfig } = require('../controllers/attendanceConfigController');

router.get('/',    getConfig);
router.put('/',    updateConfig);

module.exports = router;
