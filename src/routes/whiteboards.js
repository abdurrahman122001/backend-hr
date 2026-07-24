const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const wb = require("../controllers/whiteboardController");

// All whiteboard routes are employee-authenticated and tenant-scoped by owner.
router.get("/", empAuth, wb.list);
router.get("/trash", empAuth, wb.trash);
router.post("/", empAuth, wb.create);
router.post("/seed", empAuth, wb.seed);

router.get("/:id", empAuth, wb.getOne);
router.patch("/:id", empAuth, wb.update);
router.put("/:id/items", empAuth, wb.updateItems);
router.post("/:id/favorite", empAuth, wb.toggleFavorite);
router.post("/:id/duplicate", empAuth, wb.duplicate);
router.post("/:id/restore", empAuth, wb.restore);
router.delete("/:id", empAuth, wb.remove);

module.exports = router;
