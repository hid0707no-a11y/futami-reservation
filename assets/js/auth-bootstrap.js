// ふたみ予約システム スタッフ画面 共通認証ブートストラップ
//
// 2026-05-05 新設（/gfu Phase B-2）。
// staff.html / staff2.html / staff_tennis.html に重複していた Firebase auth init・onAuthStateChanged・
// getAuthHeader・doLogin/doLogout・API_BASE を1ファイルに集約する。
//
// 使い方（HTML側）：
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
//   <script src="assets/js/auth-bootstrap.js" data-load-fn="loadData"></script>
//
// ログイン成功時に呼び出す関数名を data-load-fn 属性で指定（HTMLファイルごとに違う・後方の <script> で定義される）。
//
// 公開：window._fbAuth / window._fbUser / window.API_BASE / window.getAuthHeader / window.doLogin / window.doLogout
//
// ★Firebase apiKey はクライアント公開前提の値（漏洩リスクなし）。Firestore rules deny-all で書込みは Functions 経由のみ。

// 自身の <script> タグから設定を読み取る（onAuthStateChanged コールバックでは取得できないので同期で確保）
var _AUTH_BOOTSTRAP_SCRIPT = document.currentScript;
var _AUTH_BOOTSTRAP_LOAD_FN = _AUTH_BOOTSTRAP_SCRIPT ? _AUTH_BOOTSTRAP_SCRIPT.getAttribute('data-load-fn') : null;

firebase.initializeApp({
  apiKey: "AIzaSyDS4b-ukVqd1iiMo7DeRIB2tzKwrt-or10",
  authDomain: "futami-yoyaku-492607.firebaseapp.com",
  projectId: "futami-yoyaku-492607"
});

var _fbAuth = firebase.auth();
var _fbUser = null;
var API_BASE = 'https://asia-northeast1-futami-yoyaku-492607.cloudfunctions.net';

_fbAuth.onAuthStateChanged(function(user) {
  if (user) {
    _fbUser = user;
    var ov = document.getElementById('login-overlay');
    if (ov && ov.remove) ov.remove();
    if (_AUTH_BOOTSTRAP_LOAD_FN) {
      var _tryCount = 0;
      (function tryLoad() {
        var fn = window[_AUTH_BOOTSTRAP_LOAD_FN];
        if (typeof fn === 'function') {
          fn();
        } else if (++_tryCount < 50) {
          setTimeout(tryLoad, 100);
        }
      })();
    }
  } else {
    var ov2 = document.getElementById('login-overlay');
    if (ov2) ov2.style.display = 'flex';
  }
});

async function getAuthHeader() {
  if (_fbUser) {
    var token = await _fbUser.getIdToken();
    return { 'Authorization': 'Bearer ' + token };
  }
  return {};
}

function doLogin() {
  var email = document.getElementById('login-email').value;
  var pass = document.getElementById('login-pass').value;
  var err = document.getElementById('login-error');
  _fbAuth.signInWithEmailAndPassword(email, pass).catch(function(e) {
    err.textContent = 'ログイン失敗: メールアドレスまたはパスワードが正しくありません';
  });
}

function doLogout() {
  _fbAuth.signOut().then(function() { location.reload(); });
}
