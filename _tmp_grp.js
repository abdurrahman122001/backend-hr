const mongoose = require('mongoose');
require('dotenv').config();
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const groups = db.collection('whatsappgroups');
  const msgs = db.collection('whatsappmessages');

  const all = await groups.find({}, { projection: { name: 1, lastMessage: 1, lastMessageAt: 1 } }).toArray();
  console.log('groups:', all.length, '\n');
  for (const g of all) {
    const latest = await msgs.find(
      { groupId: g._id, isGroupMessage: true, status: { $ne: 'draft' } },
      { projection: { note: 1, approvalStatus: 1, createdAt: 1 } },
    ).sort({ createdAt: -1 }).limit(1).toArray();
    const m = latest[0];
    const preview = String(g.lastMessage || '').slice(0, 40);
    const latestNote = m ? String(m.note || '').replace(/<[^>]*>/g, '').trim().slice(0, 40) : '';
    const polluted = m && m.approvalStatus === 'pending' && preview && latestNote.startsWith(preview.slice(0, 20));
    console.log(
      String(g.name || '(unnamed)').padEnd(22),
      '| preview:', JSON.stringify(preview).padEnd(30),
      '| latest msg status:', String(JSON.stringify(m && m.approvalStatus)).padEnd(11),
      polluted ? '  <-- PENDING TEXT IN SHARED PREVIEW' : '',
    );
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
