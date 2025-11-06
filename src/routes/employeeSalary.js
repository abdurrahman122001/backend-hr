const express = require('express');
const router = express.Router();
const controller = require('../controllers/employeeSalaryController');
const { uploadPhotos } = require("../middleware/upload");

router.get('/:id', controller.getEmployeeAndSalarySlip);
router.put('/:id', controller.updateEmployeeAndSalarySlip);
router.post("/:id/send-complete-profile", controller.resendCompleteProfileLink);
router.put('/:id/photo', uploadPhotos.single('photo'), controller.updateEmployeePhoto); // ✅ Corrected

module.exports = router;
