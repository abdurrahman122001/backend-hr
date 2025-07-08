// config/imapConfig.js
module.exports = {
  user:       process.env.IMAP_USER,
  password:   process.env.IMAP_PASSWORD,
  host:       process.env.IMAP_HOST,
  port:       +process.env.IMAP_PORT,
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
