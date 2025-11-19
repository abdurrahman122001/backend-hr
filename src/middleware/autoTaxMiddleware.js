// middleware/autoTaxMiddleware.js
const { autoApplyTaxToNewSlip } = require('../controllers/taxController');

const autoTaxMiddleware = async (req, res, next) => {
  try {
    // Call next() first to let the salary slip be created
    await next();
    
    // If salary slip was created successfully, apply tax if enabled
    if (res.locals.salarySlip) {
      const slip = res.locals.salarySlip;
      setTimeout(async () => {
        try {
          await autoApplyTaxToNewSlip(slip);
        } catch (taxError) {
          console.error('Auto-tax middleware error:', taxError);
        }
      }, 1000); // Small delay to ensure slip is fully saved
    }
  } catch (error) {
    console.error('Auto-tax middleware error:', error);
  }
};

module.exports = autoTaxMiddleware;