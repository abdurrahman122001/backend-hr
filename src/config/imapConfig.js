// config/imapConfig.js
//
// Mailbox watched by the HR watcher (watcher.js): offer acceptances/rejections,
// candidate documents, general HR mail.
//
// IMPORTANT: this must be the mailbox offer letters are SENT FROM
// (MAIL_FROM_ADDRESS) — that is where a candidate's "I accept the offer" reply
// lands. The plain IMAP_* vars are shared with the client email receiver
// (services/emailReceiverService.js), which watches the CLIENT mailbox. When
// those are two different accounts, set HR_IMAP_* for this one; it falls back
// to IMAP_* so single-mailbox setups keep working unchanged.
module.exports = {
  user:       process.env.HR_IMAP_USER || process.env.IMAP_USER,
  password:   process.env.HR_IMAP_PASSWORD || process.env.IMAP_PASSWORD,
  host:       process.env.HR_IMAP_HOST || process.env.IMAP_HOST,
  port:       +(process.env.HR_IMAP_PORT || process.env.IMAP_PORT),
  tls:        true,
  tlsOptions: { rejectUnauthorized: false },
  authTimeout: 30000,
  // Keep the connection alive and issue periodic NOOPs:
  keepalive: {
    interval:     10000,  // send a NOOP every 10 seconds
    idleInterval: 300000, // consider connection idle after 5 minutes
    forceNoop:    true
  }
};
