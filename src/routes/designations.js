const router = require("express").Router();
const { assignDesignationsToDepartment } = require("../controllers/designationController");

const {
  getDesignations,
  createDesignation,
  updateDesignation,
  deleteDesignation,
} = require("../controllers/designationController");

router.get("/", getDesignations);
router.post("/", createDesignation);
router.put("/:id", updateDesignation);
router.delete("/:id", deleteDesignation);
router.post("/assign-to-department", assignDesignationsToDepartment);

module.exports = router;
