const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth");
const ctrl = require("../controllers/leaveRecordController");

router.use(requireAuth);

// GET leave record
router.get("/me", ctrl.getMyLeaveRecord);
// Insert (create) leave record
router.post("/me", ctrl.createMyLeaveRecord);
// Update existing leave record
router.put("/me", ctrl.updateMyLeaveRecord);
router.get('/my-leave-total-entitled', ctrl.getMyTotalEntitled);
module.exports = router;
