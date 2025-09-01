const router = require("express").Router();
const requireAuth = require("../middleware/auth");
const { getOfferEmailTemplate, saveOfferEmailTemplate } = require("../controllers/offerEmailTemplateController");

router.use(requireAuth);
router.get("/", getOfferEmailTemplate);   // GET /api/offer-email?key=offer_letter
router.post("/", saveOfferEmailTemplate); // POST /api/offer-email { key, subject, html }

module.exports = router;
