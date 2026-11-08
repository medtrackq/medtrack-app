// mt-auth.js — บัตรผ่าน (session) ของคนไข้ MedTrack
// • แนบ Authorization: Bearer <session> ให้ทุกคำขอไป backend อัตโนมัติ
// • รับบัตรใหม่ที่ server ต่ออายุให้ (header X-Session-Token)
// • บัตรหาย/หมดอายุ → พาไปหน้าเข้าสู่ระบบ (medtrack-onboard.html)
(function () {
  var BACKENDS = ['https://medtrack-backend-production-7731.up.railway.app', 'https://api.medtrackq.com'];
  var TK = 'mt_session_token', PK = 'mt_user_profile', LOGIN = 'medtrack-onboard.html';
  // ไม่พาไปหน้า login เมื่อ 401 จาก endpoint เหล่านี้ (จัดการเอง)
  var NO_REDIRECT = /\/api\/(auth\/|users\/onboard|caregivers\/(dashboard|verify-token|link-token))|[?&]share=/;

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function uidFrom(t) {
    try {
      var s = atob(String(t).replace(/-/g, '+').replace(/_/g, '/'));
      var u = parseInt(s.split('.')[0], 10);
      return u > 0 ? u : null;
    } catch (e) { return null; }
  }

  var redirecting = false;
  var MTAuth = {
    token: function () { return get(TK); },
    userId: function () { var t = get(TK); return t ? uidFrom(t) : null; },
    save: function (token, user) {
      if (token) set(TK, token);
      if (user) {
        var p = {};
        try { p = JSON.parse(get(PK) || '{}') || {}; } catch (e) {}
        p.user_id = user.id; p.id = user.id;
        if (user.name) p.name = user.name;
        if (user.line_user_id) p.line_user_id = user.line_user_id;
        set(PK, JSON.stringify(p));
      }
    },
    clear: function () { del(TK); },
    loginUrl: function () {
      var here = location.pathname.split('/').pop() || 'medtrack-home.html';
      if (here === LOGIN) return LOGIN;
      return LOGIN + '?next=' + encodeURIComponent(here + location.search.replace(/([?&])(user_id|lineUserId)=[^&]*&?/g, '$1').replace(/[?&]$/, ''));
    },
    toLogin: function () {
      if (redirecting) return;
      redirecting = true;
      location.replace(MTAuth.loginUrl());
    },
    // เรียกตอนเปิดหน้า: ไม่มีบัตร → ไปหน้า login
    require: function () {
      if (!get(TK)) { MTAuth.toLogin(); return false; }
      return true;
    }
  };

  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var isApi = BACKENDS.some(function (b) { return url.indexOf(b) === 0; });
    if (!isApi) return origFetch(input, init);
    init = Object.assign({}, init || {});
    var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
    var t = get(TK);
    if (t && !h.has('Authorization')) h.set('Authorization', 'Bearer ' + t);
    init.headers = h;
    return origFetch(input, init).then(function (r) {
      var nt = r.headers.get('X-Session-Token');
      if (nt) set(TK, nt);
      if (r.status === 401 && !NO_REDIRECT.test(url)) {
        r.clone().json().then(function (j) {
          if (j && j.error === 'session_required') { MTAuth.clear(); MTAuth.toLogin(); }
        }).catch(function () {});
      }
      return r;
    });
  };
  window.MTAuth = MTAuth;
})();
