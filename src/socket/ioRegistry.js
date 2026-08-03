/**
 * Tiny registry for the Socket.IO server instance.
 *
 * Express handlers reach it with `req.app.get("io")`, but background workers
 * (the IMAP watcher, schedulers) have no `req`. index.js registers the instance
 * here once so those can emit too, without a circular require on index.js.
 */
let io = null;

function setIo(instance) {
  io = instance;
}

function getIo() {
  return io;
}

module.exports = { setIo, getIo };
