const express = require("express");
const router = express.Router();
const {
  saveOrUpdatePolicy,
  getMyPolicy,
  deleteMyPolicy,
} = require("../controllers/hrPolicyController");

router.post("/", saveOrUpdatePolicy);
router.get("/", getMyPolicy);
router.delete("/", deleteMyPolicy);

module.exports = router;
