const express = require("express");
const router = express.Router();
const bonusController = require("../controllers/bonusController");
const empAuth = require("../middleware/empAuth");
const unifiedAuth = require("../middleware/unifiedAuth");

router.post("/apply", empAuth, bonusController.applyBonus);
router.get("/my-requests", empAuth, bonusController.getMyRequests);
router.get("/all", unifiedAuth, bonusController.getAllRequests);
router.put("/update-status/:id", unifiedAuth, bonusController.updateStatus);
router.delete("/:id", unifiedAuth, bonusController.deleteRequest);

module.exports = router;
