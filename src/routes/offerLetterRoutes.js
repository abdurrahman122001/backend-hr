const router = require("express").Router();
const requireAuth = require("../middleware/auth");
const { sendOfferLetter, getSignature } = require("../controllers/offerLetterController");

router.use(requireAuth);
// single-step: realtime preview on FE, server renders again & sends + persists
router.post("/send", sendOfferLetter);
router.get("/signature", getSignature);

module.exports = router;