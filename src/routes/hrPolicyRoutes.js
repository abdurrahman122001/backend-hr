const express = require("express");
const router = express.Router();
const {
  saveOrUpdatePolicy,
  getMyPolicy,
  deleteMyPolicy,
  sendPolicyToEmployee,
} = require("../controllers/hrPolicyController");

router.post("/", saveOrUpdatePolicy);
router.get("/", getMyPolicy);
router.delete("/", deleteMyPolicy);
// Assign the HR policy to an employee's in-app mailbox (manual / re-send)
router.post("/send/:employeeId", sendPolicyToEmployee);

module.exports = router;
