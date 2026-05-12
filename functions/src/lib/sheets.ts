// スプシ同期 純粋ロジック
//
// 2026-05-05 新設（/gfu Phase B-1 部分切出し）。
// Firestore reservation document → スプシ行配列の変換は完全に純粋関数。
// API 呼び出し（spreadsheets.values.update 等）は index.ts に残す（segregated I/O）。

import { formatCustomerAddress, formatSaunaOptions } from './format';

export interface ReservationRow {
  id: string;
  createdAt: string;
  status: string;
  planId: string;
  roomIds: string;
  startDate: string;
  endDate: string;
  nights: number;
  timeStr: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerZip: string;
  customerAddress: string;
  guestsAdult: number;
  guestsElementary: number;
  guestsChild: number;
  guestsSportEstimate: number;
  pricingTotal: number;
  pricingLightingFee: number;
  weekdayDiscountHours: number;
  isResident: string;
  createdBy: string;
  saunaOptions: string;
  note: string;
}

// SHEET_HEADERS と rowToArray は同じ列順を維持しなければならない。
// 列追加時：
//   1. SHEET_HEADERS に追加
//   2. ReservationRow に追加
//   3. rowToArray の末尾に追加
//   4. functions/src/constants.ts の SHEET_LAST_COLUMN を更新（A:Y → A:Z 等）
//   5. commit message に [sheet-schema] タグ
export const SHEET_HEADERS: string[] = [
  '予約ID', '登録日時', 'ステータス', 'プランID', '部屋ID',
  '利用開始日', '利用終了日', '泊数', '時間帯',
  'お名前', '電話番号', 'メール', '郵便番号', '住所',
  '大人', '小学生', '未就学児', '利用予定人数(目安)',
  '合計金額', '照明料金', '平日割適用枠数',
  '市民区分', '予約経路', 'サウナオプション', '備考',
];

/** ReservationRow → スプシ書込み用配列（列順は SHEET_HEADERS と一致）。 */
export function rowToArray(r: ReservationRow): (string | number)[] {
  return [
    r.id, r.createdAt, r.status, r.planId, r.roomIds,
    r.startDate, r.endDate, r.nights, r.timeStr,
    r.customerName, r.customerPhone, r.customerEmail, r.customerZip, r.customerAddress,
    r.guestsAdult, r.guestsElementary, r.guestsChild, r.guestsSportEstimate,
    r.pricingTotal, r.pricingLightingFee, r.weekdayDiscountHours,
    r.isResident, r.createdBy, r.saunaOptions, r.note,
  ];
}

/** Firestore reservation document → ReservationRow（純粋関数・テスト容易）。 */
export function reservationToRow(id: string, data: any): ReservationRow {
  const pricing = data?.pricing || {};
  const tennis = pricing.tennis || {};
  const midori = pricing.midori || {};
  const slots: string[] = Array.isArray(data?.slots) ? data.slots : [];
  const uniqHours = new Set<string>();
  for (const s of slots) {
    const parts = String(s).split('|');
    if (parts.length === 3) uniqHours.add(parts[2]);
  }
  const timeStr = Array.from(uniqHours).sort().join(',');

  const createdAt = data?.createdAt?.toDate ? data.createdAt.toDate().toISOString() : '';
  const customer = data?.customer || {};
  const guests = data?.guests || {};
  return {
    id,
    createdAt,
    status: data?.status || '',
    planId: data?.planId || '',
    roomIds: Array.isArray(data?.roomIds) ? data.roomIds.join(',') : '',
    startDate: data?.startDate || '',
    endDate: data?.endDate || '',
    nights: typeof data?.nights === 'number' ? data.nights : 0,
    timeStr,
    customerName: customer.name || '',
    customerPhone: customer.phone || '',
    customerEmail: customer.email || '',
    customerZip: customer.zip || '',
    customerAddress: formatCustomerAddress(customer).replace(/^〒\S+\s*/, ''),
    guestsAdult: typeof guests.adult === 'number' ? guests.adult : 0,
    guestsElementary: typeof guests.elementary === 'number' ? guests.elementary : 0,
    guestsChild: typeof guests.child === 'number' ? guests.child : 0,
    guestsSportEstimate: typeof pricing.sportGuestEstimate === 'number' ? pricing.sportGuestEstimate : 0,
    pricingTotal: typeof pricing.total === 'number' ? pricing.total : 0,
    pricingLightingFee: (tennis.lightingFee || 0) + (midori.lightingFee || 0),
    weekdayDiscountHours: typeof tennis.weekdayDiscountHours === 'number' ? tennis.weekdayDiscountHours : 0,
    isResident: customer.isMember === true ? '市民' : '市外',
    createdBy: data?.createdBy || '',
    note: (data?.note || '').toString().slice(0, 500),
    saunaOptions: formatSaunaOptions(pricing.saunaOptions),
  };
}
