const express = require("express");
const {
  getStorageUsage,
} = require("../controllers/storageUsageController");

const router = express.Router();

router.get("/", getStorageUsage);

module.exports = router;
