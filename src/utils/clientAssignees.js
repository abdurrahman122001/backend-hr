/**
 * Client assignment is owned by the businesses: each business carries its own
 * assignedTo list, and a client has no assignment of its own any more.
 *
 * ClientInfo.assignedTo is kept as a DERIVED union of every business's
 * assignees because the rest of the application keys off it — WhatsApp chat
 * lists, email routing, "which clients can I see" queries and chat-space
 * membership all read client.assignedTo. Rebuilding it here means those
 * features keep working untouched while assignment itself moves to businesses.
 *
 * Call this after any change to businesses[].assignedTo, before saving.
 *
 * IMPORTANT: when no business has any assignee the existing client-level list
 * is LEFT ALONE. Clients created before businesses existed still hold their
 * assignment there, and the client form submits its whole businesses array on
 * every save — recomputing unconditionally would wipe those assignees the first
 * time such a client was edited, silently cutting the assigned employees off
 * from the client's mail and chats.
 */
function syncClientAssignees(client) {
  if (!client) return client;

  const seen = new Set();
  const union = [];

  for (const business of client.businesses || []) {
    for (const employee of business.assignedTo || []) {
      // Entries may be raw ObjectIds or populated employee docs.
      const id = employee && employee._id ? employee._id : employee;
      if (!id) continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(id);
    }
  }

  if (union.length === 0) return client;

  client.assignedTo = union;
  return client;
}

module.exports = { syncClientAssignees };
