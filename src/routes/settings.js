const router       = require('express').Router();
const {
  getSettings,
  updateSettings
} = require('../controllers/SettingsController');


router.get('/',    getSettings);
router.put('/',    updateSettings);

module.exports = router;
