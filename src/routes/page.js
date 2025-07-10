const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pagesController');



router.get('/permissions/:role', ctrl.getPagesPermissionsByRole);

router.patch('/:pageId/permissions/:role', ctrl.updatePagePermissionForRole);
module.exports = router;
