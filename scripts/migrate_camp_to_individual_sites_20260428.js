#!/usr/bin/env node
/**
 * 既存キャンプ予約を camp_1〜camp_8 個別区画に移行
 *
 * ⚠️ このスクリプトは 2026-04-28 に1度実行済み（migratedFrom フィールド付与済み）。
 * 履歴として残しているが、再実行は冪等skipで既migration分には影響しない設計。
 * 新規 'camp' 形式の予約は createReservation 側で発生しないので通常再実行不要。
 *
 * Before: roomIds=['camp'], slots=['camp|YYYY-MM-DD|HH', ...], shared_slots/camp|...
 * After:  roomIds=['camp_N',...], slots=['camp_N|YYYY-MM-DD|HH', ...], slots/camp_N|...
 *
 * 割当ロジック（社長指示「①から埋めて」）:
 *   日付ごとに既存予約を createdAt 昇順でソートし、guestCount分だけ camp_1 から順に割当。
 *   日付ごとに使用済みの camp_N を追跡し、競合しないよう次の番号を採番。
 *
 * 冪等性: data.migratedFrom === 'shared_slots_camp' をスキップ条件として参照。
 *
 * Usage:
 *   node migrate_camp_to_individual_sites_20260428.js          # DRY-RUN
 *   node migrate_camp_to_individual_sites_20260428.js --apply  # 実行
 */

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'futami-yoyaku-492607' });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--apply');
console.log('Mode:', DRY_RUN ? 'DRY-RUN' : 'APPLY');
console.log('');

(async () => {
  const snap = await db.collection('reservations')
    .where('isCamp', '==', true)
    .where('status', '==', 'confirmed')
    .get();

  console.log(`Found camp reservations: ${snap.size}`);
  if (snap.size === 0) {
    console.log('No reservations to migrate. Cleaning legacy shared_slots only.');
  }

  // 日付ごとに「占有中の camp_N」を追跡（migration中の重複割当防止）
  // key: date string, value: Set of allocated camp_N ('camp_1' etc)
  const allocByDate = new Map();

  // 全予約を取り出し createdAt asc でソート
  const allRes = snap.docs.map(d => ({
    id: d.id,
    data: d.data(),
    createdAt: d.data().createdAt && d.data().createdAt.toMillis ? d.data().createdAt.toMillis() : 0,
  }));
  allRes.sort((a, b) => {
    if (a.data.startDate !== b.data.startDate) return a.data.startDate < b.data.startDate ? -1 : 1;
    return a.createdAt - b.createdAt;
  });

  const plans = [];
  for (const r of allRes) {
    // 冪等性: 既にmigration済み（migratedFrom が記録されている）はスキップ
    // 再実行時に既存の roomIds を上書きしてしまうのを防ぐ
    if (r.data.migratedFrom === 'shared_slots_camp') {
      console.log(`  ⏭ ${r.id} already migrated (migratedAt=${r.data.migratedAt && r.data.migratedAt.toDate ? r.data.migratedAt.toDate().toISOString() : '?'}), skip`);
      continue;
    }
    const oldSlots = r.data.slots || [];
    if (oldSlots.length === 0) continue;
    const sites = r.data.guestCount || 1;
    // 関連する日付一覧を抽出（slots[].split('|')[1]）
    const dates = new Set();
    for (const k of oldSlots) {
      const parts = String(k).split('|');
      if (parts.length === 3) dates.add(parts[1]);
    }
    // この予約に割り当てる camp_N を sites 個分採番（全該当日で競合しない番号）
    const myCampIds = [];
    for (let i = 1; i <= 8 && myCampIds.length < sites; i++) {
      const cid = `camp_${i}`;
      let usable = true;
      for (const d of dates) {
        const used = allocByDate.get(d) || new Set();
        if (used.has(cid)) { usable = false; break; }
      }
      if (usable) myCampIds.push(cid);
    }
    if (myCampIds.length < sites) {
      console.warn(`  ⚠️  ${r.id}: 容量不足 sites=${sites} dates=[${[...dates].join(',')}] - 割当 ${myCampIds.length} 区画でcap`);
    }
    // 割当決定
    for (const d of dates) {
      const used = allocByDate.get(d) || new Set();
      myCampIds.forEach(cid => used.add(cid));
      allocByDate.set(d, used);
    }
    // 新しい slots 配列を生成
    const hoursPerDate = new Map(); // date -> [hours]
    for (const k of oldSlots) {
      const parts = String(k).split('|');
      if (parts.length !== 3) continue;
      const date = parts[1];
      const hour = parts[2];
      if (!hoursPerDate.has(date)) hoursPerDate.set(date, []);
      hoursPerDate.get(date).push(hour);
    }
    const newSlots = [];
    for (const cid of myCampIds) {
      for (const [date, hours] of hoursPerDate) {
        for (const h of hours) newSlots.push(`${cid}|${date}|${h}`);
      }
    }
    plans.push({ resId: r.id, oldSlots, newSlots, myCampIds, dates: [...dates] });
    console.log(`  ${r.id} | ${r.data.startDate} | sites=${sites} → assigned [${myCampIds.join(',')}]`);
  }

  console.log('');
  console.log('=== Plan summary ===');
  console.log(`Reservations to migrate: ${plans.length}`);
  console.log(`Total new slots to write: ${plans.reduce((s, p) => s + p.newSlots.length, 0)}`);

  // shared_slots/camp|... を削除対象として列挙
  const sharedSnap = await db.collection('shared_slots').where('roomId', '==', 'camp').get();
  console.log(`Legacy shared_slots/camp|... to delete: ${sharedSnap.size}`);

  if (DRY_RUN) {
    console.log('');
    console.log('DRY-RUN: no changes applied. Re-run with --apply to execute.');
    return;
  }

  // === APPLY ===
  console.log('');
  console.log('=== Applying ===');

  // 1. 各予約を更新 + 新スロット書込（バッチ書込・competing transactionとぶつからないので安全）
  for (const p of plans) {
    // 既存slotの存在チェック（事前read）
    const existsResults = await Promise.all(
      p.newSlots.map(key => db.collection('slots').doc(key).get())
    );
    const batch = db.batch();
    for (let i = 0; i < p.newSlots.length; i++) {
      const key = p.newSlots[i];
      const [, date, hourStr] = key.split('|');
      const ref = db.collection('slots').doc(key);
      if (existsResults[i].exists) {
        console.warn(`  ⚠️  slots/${key} already exists, skipping write`);
        continue;
      }
      const roomId = key.split('|')[0];
      batch.set(ref, {
        slotKey: key,
        roomId,
        date,
        hour: parseInt(hourStr, 10),
        reservationId: p.resId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    batch.update(db.collection('reservations').doc(p.resId), {
      roomIds: p.myCampIds,
      slots: p.newSlots,
      migratedFrom: 'shared_slots_camp',
      migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();
    console.log(`  ✅ migrated ${p.resId}`);
  }

  // 2. レガシー shared_slots を削除
  let deleted = 0;
  for (const doc of sharedSnap.docs) {
    await doc.ref.delete();
    deleted++;
  }
  console.log(`  ✅ deleted ${deleted} legacy shared_slots/camp|...`);

  console.log('');
  console.log('=== Done ===');
  console.log(`Migrated reservations: ${plans.length}`);
  console.log(`Deleted shared_slots: ${deleted}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
