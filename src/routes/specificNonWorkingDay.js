// src/routes/specificNonWorkingDay.js

const router = require("express").Router();
const {
  getSpecificNonWorkingDays,
  getSpecificNonWorkingDaysByDate,
  createSpecificNonWorkingDay,
  deleteSpecificNonWorkingDay,
} = require("../controllers/specificNonWorkingDayController");

router.get("/", getSpecificNonWorkingDays);
router.get("/by-date", getSpecificNonWorkingDaysByDate);
router.post("/", createSpecificNonWorkingDay);
router.delete("/", deleteSpecificNonWorkingDay);

module.exports = router;
