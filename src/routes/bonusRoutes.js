const express = require("express");
const router = express.Router();
const bonusController = require("../controllers/bonusController");
const empAuth = require("../middleware/empAuth");
const unifiedAuth = require("../middleware/unifiedAuth");
const { payrollReviewGuard } = require("../services/payrollRequestHierarchyService");
const BonusRequest = require("../models/BonusRequest");

router.post("/apply", empAuth, bonusController.applyBonus);
router.get("/my-requests", empAuth, bonusController.getMyRequests);
router.get("/all", unifiedAuth, bonusController.getAllRequests);
router.put("/update-status/:id", unifiedAuth, payrollReviewGuard(BonusRequest), bonusController.updateStatus);
router.delete("/:id", unifiedAuth, bonusController.deleteRequest);

module.exports = router;
