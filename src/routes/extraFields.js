const express = require('express');
const router = express.Router();
const extraFieldsController = require('../controllers/extraFieldsController');

router.get('/', extraFieldsController.getExtraFields);
router.post('/', extraFieldsController.createExtraField);
router.delete('/:id', extraFieldsController.deleteExtraField);

module.exports = router;
