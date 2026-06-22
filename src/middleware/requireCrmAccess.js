// backend/src/middleware/requireCrmAccess.js
// Assumes empAuth has already run and populated req.employee.
// Gates CRM-only actions (send on behalf of a client, add/update client)
// so they can only be performed by CRM-access holders (or the rootManager),
// i.e. only from the standalone CRM app.
const { hasCrmAccess } = require("../utils/crmAccess");

module.exports = async function requireCrmAccess(req, res, next) {
    try {
        if (!req.employee || !req.employee._id) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const allowed = await hasCrmAccess(req.employee);
        if (!allowed) {
            return res.status(403).json({ error: "CRM access required" });
        }
        return next();
    } catch (err) {
        console.error("🔐 [requireCrmAccess] Error:", err.message);
        return res.status(500).json({ error: "Server error" });
    }
};
