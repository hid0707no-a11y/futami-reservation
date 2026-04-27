const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--apply') ? false : true;
console.log('Mode:', DRY_RUN ? 'DRY-RUN' : 'APPLY');
console.log('');

(async () => {
  const snap = await db.collection('reservations')
    .where('createdBy', '==', 'migration')
    .where('roomIds', 'array-contains', 'camp')
    .get();

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  console.log('Today:', todayStr);
  console.log('Found migration camp reservations:', snap.size);
  console.log('');

  let actions = { slotDeletes: 0, sharedSlotCreates: 0, reservationsKept: 0 };

  for (const d of snap.docs) {
    const x = d.data();
    const resId = d.id;
    const slots = x.slots || [];
    const isPast = x.endDate < todayStr;
    console.log(`--- ${resId} | ${x.startDate} → ${x.endDate} (${isPast ? 'PAST' : 'FUTURE'}) | customer: ${x.customer?.name}`);

    for (const key of slots) {
      const slotRef = db.collection('slots').doc(key);
      const slotDoc = await slotRef.get();
      if (slotDoc.exists) {
        actions.slotDeletes++;
        console.log(`  DEL slots/${key}`);
        if (!DRY_RUN) await slotRef.delete();
      } else {
        console.log(`  SKIP slots/${key} (not exists)`);
      }

      if (!isPast) {
        const sharedRef = db.collection('shared_slots').doc(key);
        const existing = await sharedRef.get();
        if (existing.exists) {
          console.log(`  WARN shared_slots/${key} already exists -> ${JSON.stringify(existing.data())}`);
          actions.sharedSlotCreates++;
          if (!DRY_RUN) {
            await sharedRef.update({
              used: admin.firestore.FieldValue.increment(1),
              reservationIds: admin.firestore.FieldValue.arrayUnion(resId),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        } else {
          actions.sharedSlotCreates++;
          const [, date, hourStr] = key.split('|');
          console.log(`  ADD shared_slots/${key} {capacity:8, used:1, reservationIds:[${resId}]}`);
          if (!DRY_RUN) {
            await sharedRef.set({
              slotKey: key,
              roomId: 'camp',
              date,
              hour: parseInt(hourStr, 10),
              capacity: 8,
              used: 1,
              reservationIds: [resId],
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              note: 'migrated from slots collection (2026-04-26 patch)',
            });
          }
        }
      }
    }
    actions.reservationsKept++;
  }

  console.log('');
  console.log('=== Summary ===');
  console.log('reservations kept (untouched):', actions.reservationsKept);
  console.log('slots/{camp|...} deletes:', actions.slotDeletes);
  console.log('shared_slots/{camp|...} creates:', actions.sharedSlotCreates);
  if (DRY_RUN) console.log('\n** DRY-RUN. Add --apply to execute. **');
})().catch(e => { console.error(e); process.exit(1); });
