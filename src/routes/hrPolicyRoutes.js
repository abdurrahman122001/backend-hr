const express = require("express");
const router = express.Router();
const {
  saveOrUpdatePolicy,
  getMyPolicy,
  deleteMyPolicy,
} = require("../controllers/hrPolicyController");
const requireAuth = require("../middleware/auth");

router.post("/", requireAuth, saveOrUpdatePolicy);
router.get("/", requireAuth, getMyPolicy);
router.delete("/", requireAuth, deleteMyPolicy);

module.exports = router;
