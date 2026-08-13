const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/whatsappWebhookController");

// Public by design — Meta calls these, so there is no employee token. The GET is
// guarded by the verify token and the POST by the X-Hub-Signature-256 HMAC.
router.get("/webhook", ctrl.verifyWebhook);

// express.raw keeps the body as a Buffer: Meta signs the exact bytes it sent, so
// a parsed-and-reserialised body would not match the HMAC.
router.post(
  "/webhook",
  express.raw({ type: "*/*", limit: "5mb" }),
  ctrl.receiveWebhook,
);

module.exports = router;
