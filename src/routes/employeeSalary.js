const express = require('express');
const router = express.Router();
const controller = require('../controllers/employeeSalaryController');
const { uploadPhotos } = require("../middleware/upload");
const anyPayrollAuth = require("../middleware/anyPayrollAuth");

router.get('/', anyPayrollAuth, controller.getAllMasterSalaries);
router.get('/:id', anyPayrollAuth, controller.getEmployeeAndSalarySlip);
router.get('/:id/history', anyPayrollAuth, controller.getSalaryHistory);
router.put('/:id', anyPayrollAuth, controller.updateEmployeeAndSalarySlip);
router.post("/:id/send-complete-profile", anyPayrollAuth, controller.resendCompleteProfileLink);
router.post("/:id/resend-set-password", anyPayrollAuth, controller.resendSetPasswordLink);
router.put('/:id/photo', anyPayrollAuth, uploadPhotos.single('photo'), controller.updateEmployeePhoto); // ✅ Corrected
router.post("/calc-preview", controller.calculatePreviewTax);
router.post("/payroll-calc-preview", controller.calculatePayrollPreviewTax);
module.exports = router;
