const express = require("express");
const router = express.Router();
const {
  setNoticePeriod,
  getNoticePeriod,
} = require("../controllers/noticeperiodController");

// CREATE/UPDATE
router.post("/set", setNoticePeriod);

// FETCH
router.get("/get", getNoticePeriod);

module.exports = router;
