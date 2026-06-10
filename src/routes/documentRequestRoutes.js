const express = require("express");
const router = express.Router();
const controller = require("../controllers/documentRequestController");
const empAuth = require("../middleware/empAuth");
const unifiedAuth = require("../middleware/unifiedAuth");

// Employee routes
router.post("/apply", empAuth, controller.applyDocumentRequest);
router.get("/my-requests", empAuth, controller.getMyRequests);

// Admin routes
router.get("/all", unifiedAuth, controller.getAllRequests);
router.put("/update-status/:id", unifiedAuth, controller.updateStatus);
router.delete("/:id", unifiedAuth, controller.deleteRequest);

module.exports = router;
