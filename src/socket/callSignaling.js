/**
 * 1:1 audio call signalling.
 *
 * The media itself never touches this server — it is peer-to-peer WebRTC. All
 * that happens here is the handshake: who is ringing whom, and relaying the
 * SDP/ICE blobs between the two parties.
 *
 * Identity is taken from the socket's JWT, never from the payload: a client
 * says "call employee X", it never says who it is. Likewise every relay is
 * routed from the server's own record of the call, so a third party cannot
 * inject signalling into someone else's call by guessing a callId.
 */
const jwt = require("jsonwebtoken");
const Employee = require("../models/Employees");

// callId -> { callerId, calleeId, callerSocketId, calleeSocketId, state, ringTimer }
const activeCalls = new Map();
// employeeId -> callId. One call at a time per person, so a second caller gets
// a "busy" instead of a phone ringing in the middle of another conversation.
const callByEmployee = new Map();

// How long an unanswered call rings before both sides give up.
const RING_TIMEOUT_MS = 45000;

function iceServers() {
  const servers = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  // A STUN server only tells a peer its public address; when both peers sit
  // behind restrictive NAT/firewalls (common on corporate networks) the media
  // has to be relayed, which needs TURN. Configure TURN_URL/TURN_USERNAME/
  // TURN_CREDENTIAL to cover those users — without it such calls connect for
  // signalling but never get audio.
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(",").map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

function newCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function publicUser(emp) {
  if (!emp) return null;
  return {
    _id: String(emp._id),
    name: emp.name || "Unknown",
    photographUrl: emp.photographUrl || null,
    designation: emp.designation || null,
  };
}

/** Resolve (and cache) the employee behind this socket from its JWT. */
async function resolveEmployee(socket) {
  if (socket.data.callEmployee !== undefined) return socket.data.callEmployee;

  let resolved = null;
  try {
    const raw = socket.handshake?.auth?.token || "";
    if (raw) {
      const payload = jwt.verify(
        String(raw).replace(/^Bearer\s+/i, ""),
        process.env.JWT_SECRET,
      );
      const id = payload.id || payload._id || payload.userId;
      if (id) {
        resolved = await Employee.findById(id)
          .select("_id name photographUrl designation owner")
          .lean();
      }
    }
  } catch (err) {
    console.error("[call] token verify failed:", err.message);
  }

  socket.data.callEmployee = resolved;
  return resolved;
}

function clearCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  if (call.ringTimer) clearTimeout(call.ringTimer);
  activeCalls.delete(callId);
  if (callByEmployee.get(call.callerId) === callId)
    callByEmployee.delete(call.callerId);
  if (callByEmployee.get(call.calleeId) === callId)
    callByEmployee.delete(call.calleeId);
}

/** The other end of a call, relative to one participant. */
function peerOf(call, employeeId) {
  return String(call.callerId) === String(employeeId)
    ? { id: call.calleeId, socketId: call.calleeSocketId }
    : { id: call.callerId, socketId: call.callerSocketId };
}

/**
 * Send to a specific socket once the call is connected, or to the employee's
 * room while it is still ringing (so every tab they have open rings).
 */
function emitToPeer(io, peer, event, payload) {
  if (peer.socketId) io.to(peer.socketId).emit(event, payload);
  else io.to(`employee_${peer.id}`).emit(event, payload);
}

function registerCallHandlers(io, socket) {
  /** Guard shared by every event: resolve me, find the call, check I'm in it. */
  const withCall = async (callId, handler) => {
    const me = await resolveEmployee(socket);
    if (!me) return null;
    const call = activeCalls.get(callId);
    if (!call) return null;
    const myId = String(me._id);
    if (call.callerId !== myId && call.calleeId !== myId) return null;
    return handler(call, myId, me);
  };

  socket.on("call:invite", async (payload = {}, ack) => {
    try {
      const me = await resolveEmployee(socket);
      if (!me) {
        return typeof ack === "function" && ack({ error: "Not authenticated" });
      }

      const calleeId = String(payload.toEmployeeId || "");
      const callerId = String(me._id);
      if (!calleeId || calleeId === callerId) {
        return typeof ack === "function" && ack({ error: "Invalid callee" });
      }

      if (callByEmployee.has(callerId)) {
        return typeof ack === "function" && ack({ error: "You are already on a call" });
      }
      if (callByEmployee.has(calleeId)) {
        return typeof ack === "function" && ack({ busy: true });
      }

      const callee = await Employee.findById(calleeId)
        .select("_id name photographUrl designation owner")
        .lean();
      if (!callee) {
        return typeof ack === "function" && ack({ error: "Person not found" });
      }
      // Calls stay inside one organisation.
      if (String(callee.owner) !== String(me.owner)) {
        return typeof ack === "function" && ack({ error: "Not allowed" });
      }

      // Nobody connected on that side → straight to "unavailable" rather than
      // ringing into the void for 45 seconds.
      const calleeRoom = io.sockets.adapter.rooms.get(`employee_${calleeId}`);
      if (!calleeRoom || calleeRoom.size === 0) {
        return typeof ack === "function" && ack({ unavailable: true });
      }

      const callId = newCallId();
      const call = {
        callId,
        callerId,
        calleeId,
        callerSocketId: socket.id,
        calleeSocketId: null,
        state: "ringing",
        ringTimer: setTimeout(() => {
          const stale = activeCalls.get(callId);
          if (!stale || stale.state !== "ringing") return;
          io.to(`employee_${calleeId}`).emit("call:cancelled", {
            callId,
            reason: "timeout",
          });
          io.to(stale.callerSocketId).emit("call:ended", {
            callId,
            reason: "no_answer",
          });
          clearCall(callId);
        }, RING_TIMEOUT_MS),
      };
      activeCalls.set(callId, call);
      callByEmployee.set(callerId, callId);
      callByEmployee.set(calleeId, callId);

      // Ack the caller BEFORE ringing the callee. The caller only learns its
      // callId from this ack, so ringing first leaves a window where a very
      // fast answer produces a call:accepted the caller cannot match to any
      // call yet, and silently drops it.
      if (typeof ack === "function") {
        ack({ callId, to: publicUser(callee), iceServers: iceServers() });
      }

      io.to(`employee_${calleeId}`).emit("call:incoming", {
        callId,
        from: publicUser(me),
        // The callee has to know before answering, so it can ask for the
        // camera as well as the microphone and show the right UI.
        video: !!payload.video,
        iceServers: iceServers(),
      });
    } catch (err) {
      console.error("[call:invite]", err.message);
      if (typeof ack === "function") ack({ error: "Could not start the call" });
    }
  });

  socket.on("call:accept", async ({ callId } = {}) => {
    await withCall(callId, (call, myId) => {
      if (myId !== call.calleeId || call.state !== "ringing") return;

      call.state = "connected";
      call.calleeSocketId = socket.id;
      if (call.ringTimer) clearTimeout(call.ringTimer);
      call.ringTimer = null;

      // Stop the other tabs of the person who answered from ringing.
      io.to(`employee_${call.calleeId}`).emit("call:handled", {
        callId,
        bySocketId: socket.id,
      });
      io.to(call.callerSocketId).emit("call:accepted", { callId });
    });
  });

  socket.on("call:reject", async ({ callId, reason } = {}) => {
    await withCall(callId, (call, myId) => {
      if (myId !== call.calleeId) return;
      io.to(`employee_${call.calleeId}`).emit("call:handled", {
        callId,
        bySocketId: socket.id,
      });
      io.to(call.callerSocketId).emit("call:ended", {
        callId,
        reason: reason || "declined",
      });
      clearCall(callId);
    });
  });

  socket.on("call:cancel", async ({ callId } = {}) => {
    await withCall(callId, (call, myId) => {
      if (myId !== call.callerId) return;
      io.to(`employee_${call.calleeId}`).emit("call:cancelled", {
        callId,
        reason: "cancelled",
      });
      clearCall(callId);
    });
  });

  // SDP offer/answer and ICE candidates — relayed verbatim, routed by the
  // server's record of the call rather than anything the sender claims.
  socket.on("call:signal", async ({ callId, signal } = {}) => {
    await withCall(callId, (call, myId) => {
      if (!signal) return;
      emitToPeer(io, peerOf(call, myId), "call:signal", { callId, signal });
    });
  });

  socket.on("call:end", async ({ callId } = {}) => {
    await withCall(callId, (call, myId) => {
      emitToPeer(io, peerOf(call, myId), "call:ended", {
        callId,
        reason: "ended",
      });
      clearCall(callId);
    });
  });

  socket.on("disconnect", async () => {
    // A dropped tab must not leave the other person listening to silence, and
    // must not leave either party marked busy forever.
    const me = socket.data.callEmployee;
    if (!me) return;
    const callId = callByEmployee.get(String(me._id));
    if (!callId) return;
    const call = activeCalls.get(callId);
    if (!call) return;

    // Ringing on several tabs: only the last one going away ends the call.
    const stillHere = io.sockets.adapter.rooms.get(`employee_${me._id}`);
    if (call.state === "ringing" && stillHere && stillHere.size > 0) return;

    emitToPeer(io, peerOf(call, String(me._id)), "call:ended", {
      callId,
      reason: "disconnected",
    });
    clearCall(callId);
  });
}

module.exports = { registerCallHandlers, iceServers };
