// mt-admin.js — รหัส admin สำหรับเครื่องมือภายใน (ทดสอบ OCR / ใบนัด / เก็บข้อมูล)
// • ใส่รหัสครั้งเดียว แล้วแนบ header x-admin-secret ให้ทุกคำขอไป backend เอง (ไม่ใส่ใน URL)
// • ยังไม่ใส่รหัส → คำขอจะรอจนกว่าจะใส่ · รหัสผิด (401/403) → ถามใหม่
// • เก็บในแท็บนี้เท่านั้น (ปิดแท็บแล้วหาย) เว้นแต่ติ๊ก "จำไว้ในเครื่องนี้"
(function () {
  var HOSTS = ['https://api.medtrackq.com', 'https://medtrack-backend-production-7731.up.railway.app'];
  var K = 'mt_admin_secret';
  function load() { try { return sessionStorage.getItem(K) || localStorage.getItem(K) || ''; } catch (e) { return ''; } }
  function save(v, remember) {
    try { sessionStorage.setItem(K, v); } catch (e) {}
    try { if (remember) localStorage.setItem(K, v); else localStorage.removeItem(K); } catch (e) {}
  }
  function clear() { try { sessionStorage.removeItem(K); localStorage.removeItem(K); } catch (e) {} }

  var secret = load(), waiters = [], asking = false, rejected = false;
  function whenReady() { return secret ? Promise.resolve(secret) : new Promise(function (r) { waiters.push(r); ask(); }); }

  function css() {
    if (document.getElementById('mtAdmCss')) return;
    var s = document.createElement('style'); s.id = 'mtAdmCss';
    s.textContent = '#mtAdmPill{position:fixed;top:8px;right:8px;z-index:99999;font:600 12px system-ui,sans-serif;background:#0f172a;color:#fff;border-radius:16px;padding:5px 12px;cursor:pointer;opacity:.85}' +
      '#mtAdmBox{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center}' +
      '#mtAdmBox .c{background:#fff;border-radius:14px;padding:22px;width:min(340px,90vw);font:14px system-ui,sans-serif;color:#0f172a;box-shadow:0 10px 40px rgba(0,0,0,.3)}' +
      '#mtAdmBox h3{margin:0 0 6px;font-size:17px}#mtAdmBox p{margin:0 0 12px;color:#475569;font-size:13px}' +
      '#mtAdmBox input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px}' +
      '#mtAdmBox label{display:flex;gap:6px;align-items:center;margin:10px 0 14px;font-size:13px;color:#475569}' +
      '#mtAdmBox button{width:100%;padding:10px;border:0;border-radius:8px;background:#0a9c7a;color:#fff;font:700 15px system-ui,sans-serif;cursor:pointer}' +
      '#mtAdmBox .err{color:#dc2626;font-size:13px;min-height:16px;margin-top:6px}';
    document.head.appendChild(s);
  }
  function pill() {
    if (!document.body) return;
    css();
    var p = document.getElementById('mtAdmPill');
    if (!p) { p = document.createElement('div'); p.id = 'mtAdmPill'; document.body.appendChild(p); }
    p.textContent = secret ? '🔓 Admin · ออก' : '🔐 ใส่รหัส Admin';
    p.title = secret ? 'ล้างรหัส admin ออกจากเครื่องนี้' : 'ใส่รหัส admin';
    p.onclick = function () { if (secret) { secret = ''; clear(); pill(); } else ask(); };
  }
  function ask(msg) {
    if (asking) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { ask(msg); }); return; }
    asking = true; css();
    var b = document.createElement('div'); b.id = 'mtAdmBox';
    b.innerHTML = '<div class="c"><h3>🔐 รหัส Admin</h3><p>เครื่องมือนี้ใช้ได้เฉพาะผู้ดูแลระบบ<br>ใช้รหัสเดียวกับ admin-monitor</p>' +
      '<input type="password" id="mtAdmIn" autocomplete="current-password" placeholder="ADMIN_SECRET">' +
      '<label><input type="checkbox" id="mtAdmRem"> จำไว้ในเครื่องนี้ (เฉพาะคอมส่วนตัว)</label>' +
      '<button id="mtAdmOk">เข้าใช้งาน</button><div class="err">' + (msg || '') + '</div></div>';
    document.body.appendChild(b);
    var inp = document.getElementById('mtAdmIn'); inp.focus();
    var go = function () {
      var v = inp.value.trim(); if (!v) return;
      secret = v; save(v, document.getElementById('mtAdmRem').checked);
      b.remove(); asking = false; pill();
      if (rejected) { location.reload(); return; }   // หน้าโหลดข้อมูลไม่สำเร็จไปแล้ว → โหลดใหม่ด้วยรหัสที่ถูก
      var w = waiters; waiters = []; w.forEach(function (r) { r(v); });
    };
    document.getElementById('mtAdmOk').onclick = go;
    inp.onkeydown = function (e) { if (e.key === 'Enter') go(); };
  }

  var of = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!HOSTS.some(function (h) { return url.indexOf(h) === 0; })) return of(input, init);
    return whenReady().then(function (sec) {
      var i = Object.assign({}, init || {});
      var h = new Headers(i.headers || (typeof input !== 'string' && input.headers) || {});
      h.set('x-admin-secret', sec); i.headers = h;
      return of(input, i).then(function (r) {
        if ((r.status === 401 || r.status === 403) && secret === sec) {
          secret = ''; clear(); pill(); rejected = true; ask('รหัสไม่ถูกต้อง ลองใหม่อีกครั้ง');
        }
        return r;
      });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pill); else pill();
  window.MTAdmin = { clear: function () { secret = ''; clear(); pill(); } };
})();
