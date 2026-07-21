// services/emailPollingService.js - FIXED VERSION
const emailReceiverService = require('./emailReceiverService');

class EmailPollingService {
  // This is only a SAFETY NET — new mail is already handled in real time via
  // the IMAP `mail` (IDLE) event in emailReceiverService. A tight 30s poll made
  // the single vCPU re-fetch + MIME-parse every 30s for no benefit, so the
  // fallback sweep runs every 5 minutes instead.
  constructor(checkInterval = 5 * 60 * 1000) {
    this.checkInterval = checkInterval;
    this.pollingInterval = null;
  }

  startPolling() {
    console.log(`🔄 [EmailPolling] Starting email polling every ${this.checkInterval/1000} seconds`);
    
    this.pollingInterval = setInterval(async () => {
      try {
        if (emailReceiverService.isConnected) {
          // Use the correct method name that exists in emailReceiverService
          await emailReceiverService.checkForNewEmails();
        } else {
          console.log('⚠️ [EmailPolling] IMAP not connected, attempting to reconnect...');
          emailReceiverService.connect();
        }
      } catch (error) {
        console.error('❌ [EmailPolling] Error in polling:', error.message || error);
      }
    }, this.checkInterval);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      console.log('🛑 [EmailPolling] Email polling stopped');
    }
  }
}

module.exports = new EmailPollingService();