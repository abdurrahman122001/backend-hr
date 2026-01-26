const natural = require('natural');
const tokenizer = new natural.WordTokenizer();

/**
 * Extract leave-related rules from HR policy
 */
exports.extractLeaveRules = (policyContent) => {
  const rules = {
    paidLeaveAdvanceNoticeDays: null,
    totalPaidLeavesPerYear: null,
    hasSandwichPolicy: false,
    probationPeriodMonths: null,
    annualLeaveEntitlement: 22 // Default from policy
  };

  if (!policyContent) return rules;

  // Convert to lowercase for easier matching
  const content = policyContent.toLowerCase();
  
  // Extract 7 working days advance notice for paid leave
  const advanceNoticeMatch = content.match(/at least (\d+) working days in advance/);
  if (advanceNoticeMatch) {
    rules.paidLeaveAdvanceNoticeDays = parseInt(advanceNoticeMatch[1]);
  }
  
  // Extract total paid leaves per year
  const totalLeavesMatch = content.match(/(\d+) paid leaves per year/);
  if (totalLeavesMatch) {
    rules.totalPaidLeavesPerYear = parseInt(totalLeavesMatch[1]);
  }
  
  // Check for sandwich policy
  if (content.includes('sandwich') && content.includes('off day') && content.includes('counted as leave')) {
    rules.hasSandwichPolicy = true;
  }
  
  // Extract probation period
  const probationMatch = content.match(/probationary period of (\d+) months/);
  if (probationMatch) {
    rules.probationPeriodMonths = parseInt(probationMatch[1]);
  }
  
  // Extract annual leave entitlement (22 days from policy)
  const annualLeavesMatch = content.match(/(\d+) paid leaves per year/);
  if (annualLeavesMatch) {
    rules.annualLeaveEntitlement = parseInt(annualLeavesMatch[1]);
  }
  
  return rules;
};

/**
 * Calculate working days between two dates (excluding weekends)
 */
exports.calculateWorkingDays = (startDate, endDate, holidays = []) => {
  let count = 0;
  const current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current <= end) {
    const dayOfWeek = current.getDay();
    // Sunday = 0, Saturday = 6
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Check if it's a holiday
      const dateStr = current.toISOString().split('T')[0];
      if (!holidays.includes(dateStr)) {
        count++;
      }
    }
    current.setDate(current.getDate() + 1);
  }
  
  return count;
};

/**
 * Determine if employee is on probation
 */
exports.isEmployeeOnProbation = (joiningDate, probationMonths) => {
  if (!joiningDate || !probationMonths) return false;
  
  const joinDate = new Date(joiningDate);
  const today = new Date();
  
  // Calculate months difference
  const monthsDiff = (today.getFullYear() - joinDate.getFullYear()) * 12 + 
                    (today.getMonth() - joinDate.getMonth());
  
  return monthsDiff < probationMonths;
};