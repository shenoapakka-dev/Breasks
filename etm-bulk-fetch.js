/* ETM – سحب بيانات طلبات الإلغاء عن طريق iframe (بدون API)
   الاستخدام: افتح أي صفحة في etm.panemirates.ae → F12 → Console → الصق الكود → Enter
   (أو احفظه كـ Snippet في DevTools › Sources › Snippets وشغّله بـ Ctrl+Enter) */
(() => {
  const URL_SEARCH = '/ordering/floor/order-search';
  // Cancel Desk page URL — update this if the repo/domain changes.
  const CANCEL_DESK_URL = 'https://shenoapakka-dev.github.io/Breasks/';
  const WAIT_MS = 20000, GAP_MS = 600;
  document.getElementById('cxPanel')?.remove();

  const css = `#cxPanel{position:fixed;top:60px;right:20px;width:760px;max-height:85vh;z-index:99999;background:#fff;border:1px solid #3c8dbc;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:13px Tahoma,Arial;direction:rtl;display:flex;flex-direction:column}
#cxPanel header{background:#3c8dbc;color:#fff;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;border-radius:8px 8px 0 0}
#cxPanel .b{padding:10px;overflow:auto}#cxPanel textarea{width:100%;height:90px;direction:ltr;font-family:monospace}
#cxPanel button{margin:4px 2px;padding:5px 12px;border:0;border-radius:4px;background:#3c8dbc;color:#fff;cursor:pointer}#cxPanel button.g{background:#00a65a}#cxPanel button.r{background:#dd4b39}
#cxPanel table{border-collapse:collapse;width:100%;margin-top:8px;font-size:12px}#cxPanel td,#cxPanel th{border:1px solid #ddd;padding:3px 5px;text-align:right;white-space:nowrap}#cxPanel th{background:#f4f4f4;position:sticky;top:0}
#cxPanel iframe{width:100%;height:0;border:0}#cxPanel.show iframe{height:260px;border:1px dashed #aaa}#cxMsg{margin:4px 0;color:#555}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const p = document.createElement('div'); p.id = 'cxPanel';
  p.innerHTML = `<header><b>سحب طلبات الإلغاء من ETM</b><span><button id="cxShow">إظهار الـ iframe</button><button class="r" id="cxClose">✕</button></span></header>
  <div class="b"><div>الصق أرقام الطلبات (كل رقم في سطر أو مفصولة بفاصلة/مسافة):</div>
  <textarea id="cxIn" placeholder="WU1103464&#10;WU1103465"></textarea>
  <div><button class="g" id="cxGo">▶ ابدأ</button><button class="r" id="cxStop">■ إيقاف</button><button id="cxCsv">⬇ CSV</button><button id="cxCopy">📋 نسخ للإكسل</button></div>
  <div id="cxMsg"></div><iframe id="cxF" src="${URL_SEARCH}"></iframe><div id="cxOut"></div></div>`;
  document.body.appendChild(p);

  const $ = id => p.querySelector('#' + id), F = $('cxF');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const COLS = ['Order','Result','Customer','Mobile','Order Date','Delivery Date','Total','Paid Amount','Status','Blocked','COD Ready','Trip | Driver | Mobile','Address','Area','Notes','Items Count','Items'];
  let rows = [], stop = false;

  const doc = () => { try { return F.contentDocument; } catch (e) { return null; } };
  const waitLoad = () => new Promise(r => { const h = () => { F.removeEventListener('load', h); r(); }; F.addEventListener('load', h); });
  const ready = async () => { for (let i = 0; i < 100; i++) { const d = doc(); if (d && d.readyState === 'complete' && d.querySelector('[name="orderform[order]"]')) return d; await sleep(200); } throw new Error('الصفحة لم تحمّل'); };

  function parse(d, order) {
    const r = { Order: order, Result: 'OK' };
    d.querySelectorAll('table.detail-view tr').forEach(tr => {
      const k = clean(tr.querySelector('th')?.textContent), v = clean(tr.querySelector('td')?.textContent);
      if (k) r[k.replace(/\s*-\s*/g, ' - ')] = v;
    });
    const items = [...d.querySelectorAll('table.kv-grid-table tbody tr')].filter(tr => tr.cells.length > 4)
      .map(tr => { const c = [...tr.cells].map(x => clean(x.textContent)); return `${c[1]} ${c[2]} x${c[4]}`; });
    r['Items Count'] = items.length; r['Items'] = items.join(' || ');
    return r;
  }

  async function fetchOne(order) {
    let d = await ready();
    d.querySelector('[name="orderform[order]"]').value = order;
    const form = d.querySelector('[name="orderform[order]"]').form;
    const btn = [...form.querySelectorAll('button,input[type=submit]')].find(b => /search/i.test(b.textContent || b.value)) || form.querySelector('button.btn-primary');
    const t0 = Date.now();
    btn ? btn.click() : form.requestSubmit();       // الصفحة بتجيب التفاصيل بـ AJAX جوه #orderContent
    await sleep(500);
    while (Date.now() - t0 < WAIT_MS) {           // يدعم التحميل الكامل و pjax
      d = doc();
      if (d && d.body && d.body.innerText.includes(`( ${order} )`) && d.querySelector('table.detail-view')) return parse(d, order);
      await sleep(300);
    }
    return { Order: order, Result: 'غير موجود / انتهت المهلة' };
  }

  function sendUrl(r) {
    const u = new URL(CANCEL_DESK_URL);
    u.searchParams.set('order', r.Order || '');
    const mobile = String(r.Mobile || '').split('|')[0].trim();
    if (mobile) u.searchParams.set('mobile', mobile);
    const amount = String(r.Total || '').replace(/[^\d.]/g, '');
    if (amount) u.searchParams.set('amount', amount);
    if (r.Items) u.searchParams.set('items', r.Items);
    return u.toString();
  }
  function render() {
    const t = '<table><tr>' + COLS.map(c => `<th>${c}</th>`).join('') + '<th>إرسال</th></tr>' +
      rows.map((r, i) => '<tr>' + COLS.map(c => `<td>${(r[c] ?? '').toString().replace(/</g, '&lt;')}</td>`).join('') +
        (r.Result === 'OK' ? `<td><button class="g" data-send="${i}">➡ مكتب الإلغاء</button></td>` : '<td></td>') + '</tr>').join('') + '</table>';
    $('cxOut').innerHTML = t;
    $('cxOut').querySelectorAll('[data-send]').forEach(b => {
      b.onclick = () => window.open(sendUrl(rows[+b.dataset.send]), '_blank');
    });
  }
  const toDelim = sep => [COLS, ...rows.map(r => COLS.map(c => r[c] ?? ''))]
    .map(a => a.map(v => { v = String(v); return sep === ',' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v.replace(/\t|\n/g, ' '); }).join(sep)).join('\n');

  $('cxGo').onclick = async () => {
    const list = [...new Set($('cxIn').value.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (!list.length) return alert('حط أرقام الطلبات الأول');
    rows = []; stop = false; render();
    for (let i = 0; i < list.length && !stop; i++) {
      $('cxMsg').textContent = `جاري ${i + 1} / ${list.length} : ${list[i]}`;
      try { rows.push(await fetchOne(list[i])); } catch (e) { rows.push({ Order: list[i], Result: 'خطأ: ' + e.message }); }
      render(); await sleep(GAP_MS);
    }
    $('cxMsg').textContent = (stop ? 'تم الإيقاف' : 'خلصت ✅') + ` — ${rows.filter(r => r.Result === 'OK').length} من ${rows.length} طلب`;
  };
  $('cxStop').onclick = () => stop = true;
  $('cxShow').onclick = () => p.classList.toggle('show');
  $('cxClose').onclick = () => { p.remove(); st.remove(); };
  $('cxCsv').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + toDelim(',')], { type: 'text/csv;charset=utf-8' }));
    a.download = `ETM_cancellations_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };
  $('cxCopy').onclick = async () => { await navigator.clipboard.writeText(toDelim('\t')); $('cxMsg').textContent = 'اتنسخ — الصقه في Excel'; };
})();
