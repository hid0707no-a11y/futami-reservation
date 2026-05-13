// createReservation の純粋関数部分のユニットテスト
//
// 2026-05-13 新設（Evaluator 不足2 への対応）。
// isTennisPayload の `.every` 縮退チェック。誰かが `.some` や `[0].startsWith` に
// 戻したら CI で気付けるよう保護する。

import { isTennisPayload } from '../src/handlers/createReservation';

describe('isTennisPayload', () => {
  describe('正常ケース（テニス専用ルートに分岐すべき）', () => {
    it('単一テニスコート', () => {
      expect(isTennisPayload(['court_1'])).toBe(true);
    });

    it('複数テニスコート（要望#7 複数選択 UI で発火する典型ペイロード）', () => {
      expect(isTennisPayload(['court_1', 'court_2', 'court_3'])).toBe(true);
    });

    it('全5コート同時予約', () => {
      expect(isTennisPayload(['court_1', 'court_2', 'court_3', 'court_4', 'court_5'])).toBe(true);
    });
  });

  describe('テニス以外（テニス専用ルートに入ってはいけない）', () => {
    it('キャンプのみ', () => {
      expect(isTennisPayload(['camp_1', 'camp_2'])).toBe(false);
    });

    it('宿泊のみ', () => {
      expect(isTennisPayload(['room_27', 'room_6_1'])).toBe(false);
    });

    it('みどりの広場', () => {
      expect(isTennisPayload(['midori'])).toBe(false);
    });

    it('サウナ共有 slot', () => {
      expect(isTennisPayload(['sauna_share'])).toBe(false);
    });
  });

  describe('★混在ペイロード（旧 [0].startsWith バグの再発防止）', () => {
    // 旧コード `roomIds[0].startsWith('court_')` だと先頭が court_* なら true を返し、
    // 後続のキャンプや宿泊 room が tennis_slots に書かれる脆弱性があった。
    // `.every` 化でこれを塞いだことを保護する negative テスト群。
    it('court + camp 混在は false', () => {
      expect(isTennisPayload(['court_1', 'camp_1'])).toBe(false);
    });

    it('court 先頭で後続に宿泊室が混じっていても false', () => {
      expect(isTennisPayload(['court_1', 'room_27'])).toBe(false);
    });

    it('court 中間に1件だけ非テニスが混じっても false', () => {
      expect(isTennisPayload(['court_1', 'court_2', 'midori', 'court_3'])).toBe(false);
    });

    it('全て同じ prefix でないと、たとえ全て有効な ROOM でも false', () => {
      expect(isTennisPayload(['court_1', 'lodge_a'])).toBe(false);
    });
  });

  describe('境界・防御的入力', () => {
    it('空配列は false（要望者なし）', () => {
      expect(isTennisPayload([])).toBe(false);
    });

    it('非配列（null / undefined / string）は false', () => {
      expect(isTennisPayload(null)).toBe(false);
      expect(isTennisPayload(undefined)).toBe(false);
      expect(isTennisPayload('court_1' as any)).toBe(false);
    });

    it('配列内に文字列でない要素があれば false（startsWith 呼び出し時 TypeError 防止）', () => {
      expect(isTennisPayload([null as any, 'court_1'])).toBe(false);
      expect(isTennisPayload([123 as any])).toBe(false);
    });
  });
});
