// Firestore client シングルトン
//
// 2026-05-05 新設（/gfu Phase B-1 完全分割の前提・全 handlers から import 可能に）。
// admin.firestore() を 1 箇所で取得し、全 handlers / services から共通参照する。

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
