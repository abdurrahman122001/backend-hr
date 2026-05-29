const express = require('express');
const router = express.Router();
const controller = require('../controllers/employeeSalaryController');
const { uploadPhotos } = require("../middleware/upload");
const anyPayrollAuth = require("../middleware/anyPayrollAuth");

router.get('/', anyPayrollAuth, controller.getAllMasterSalaries);
router.get('/:id', controller.getEmployeeAndSalarySlip);
router.get('/:id/history', controller.getSalaryHistory);
router.put('/:id', controller.updateEmployeeAndSalarySlip);
router.post("/:id/send-complete-profile", controller.resendCompleteProfileLink);
router.post("/:id/resend-set-password", controller.resendSetPasswordLink);
router.put('/:id/photo', uploadPhotos.single('photo'), controller.updateEmployeePhoto); // ✅ Corrected
router.post("/calc-preview", controller.calculatePreviewTax);
router.post("/payroll-calc-preview", controller.calculatePayrollPreviewTax);
module.exports = router;
