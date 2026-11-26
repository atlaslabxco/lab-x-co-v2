/* ============================================================================
   Sea & Spice — POS ORDERS (ArmLoop)
   ----------------------------------------------------------------------------
   Everything that talks to the POS about a table:

     PosOrder.shopStatus()          open / closed           POST /pro/lot/openClose
     PosOrder.tableBill(table)      what the table has      POST /shop/tab/action
                                    ordered and not paid
     PosOrder.build(cart, ctx)      cart -> payOrder body   (no network)
     PosOrder.submit(body)          send to the kitchen     POST /pro/pos/payOrder

   Settings (shop ids, table mapping, fee PLUs, on/off) live in menu-source.js.

   ORDER FLOW (agreed with the restaurant)
     Guests order from the table; the ticket goes straight to the kitchen
     UNPAID; they can keep adding orders; they pay at the counter on the POS.
     After payment the table is free again, so tableBill() returns null and
     the next guests start clean.

   FORMAT
     Built field-for-field from orders the POS accepted:
       2026-08-21  fish pot, unpaid (SYNC-BEFORE-PAID)  data/unpaid-test.json
       2026-09-01  set A01 with all 9 option groups      data/package-order-request.json
       2026-09-10  sets A01–A04                          data/package-tests-20260910.json
     Rules from ArmLoop (Marco) applied here:
       - item price = base + options; shopPrice = base; misc/totalMisc = options
       - options are `attrs` with subKeyId "<item>-<option>"
       - GST only on the base price, not on options (prices include GST)
       - sendOrderWhenPaid present -> SYNC-BEFORE-PAID: ticket prints now, pay later
       - prices are POS prices, sent unmodified
   ============================================================================ */

(function () {
  'use strict';

  var MS = window.MenuSource;
  var TEST_TABLE = 'TEST';
  var TEST_NOTE  = 'LABX TEST - DO NOT PREPARE 测试单请勿制作';
  var PLACEHOLDER_PHONE = '0000000000';   // POS needs a value; it is not a customer number

  // Bill-level fields copied from the accepted 2026-09-01 order. Order-specific
  // fields (amounts, table, items, ids, times) are filled in by build().
  var BILL_STATIC = {"lastOrderTime":0,"billType":2,"billNo":"","totalPaid":0,"orderType":2,"serviceNo":800,"roundedAmount":0,"surchargeAmount":0,"surchargeRate":0,"changeAmount":0,"deliveryFee":0,"expressFee":0,"otherChargeRate":0,"otherChargeAmount":0,"deposit":0,"serviceFee":0,"points":0,"topupPoints":0,"discountAmount":0,"discountRate":0,"userDiscountAmount":0,"otherDiscountAmount":0,"showDelivery":false,"payment":"dps","fastPay":false,"token":"","paymentAlias":"APPLE PAY / GOOGLE PAY / NEW CREDIT CARD.","payType":"301","preorder":false,"uploaded":false,"promoCode":"","promoDiscount":0,"promoRate":0,"balancedList":[],"printed":false,"paid":false,"itemDiscount":0,"wholeDiscount":0,"pointDiscount":0,"printer":"","openDrawer":0,"status":0,"totalDiscountableAmount":0,"totalDuration":0,"totalPtAndDiscAmount":0,"redeemCode":"","topupCode":"","giftCardAmount":0,"giftCards":[],"archived":false,"tags":"","plateTag":"","firstBuffetOrder":false,"orderTime":"","tax2":0,"tax3":0,"tax4":0,"tax5":0,"tax6":0,"otherChargeName":"","userId":null,"actionTimer":0,"merchantSurchargeAmount":0,"verified":true};

  var V1 = '/api/open/v1';

  /* ---------------------------------------------------------------- helpers */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function uid() {                                   // 32 hex chars, like the POS ids
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function b64(str) {                                 // UTF-8 safe (Chinese names)
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function gstOf(amount, raw) {                       // POS prices include GST
    var g = raw && typeof raw.gst === 'number' ? raw.gst : 10;
    return amount * g / (100 + g);
  }
  function tabNo(table) { return (MS.tableMap && MS.tableMap[table]) || table; }
  function shop() { return MS.shop; }

  /* ------------------------------------------------------------ shop status */
  // { open:true|false|null, msg }. null = could not tell (network); callers
  // let the order through and let payOrder be the judge.
  function shopStatus() {
    var s = shop(), now = Date.now();
    var body = { siteId: s.siteId, spotId: s.spotId, date: now, currentTime: now };
    if (s.ordLot != null) body.ordLot = s.ordLot;
    return MS._call(V1 + '/pro/lot/openClose', body).then(function (j) {
      var m = (j && j.map) || {};
      return { open: m.rtn === 1, msg: m.dispMsg || m.disp_msg || '' };
    }).catch(function (e) {
      console.warn('[PosOrder] openClose failed:', e);
      return { open: null, msg: '' };
    });
  }

  /* -------------------------------------------------------------- table bill */
  // The table's open (unpaid) bill, or null when the table is free / paid.
  // This — not the phone — is the record of what the table has ordered, so it
  // includes orders from other phones and resets itself once staff take payment.
  function tableBill(table) {
    return MS._call(V1 + '/shop/tab/action', { action: 1, tabNo: tabNo(table), lang: MS._config.lang })
      .then(function (j) {
        var d = j && j.code === 200 ? j.data : null;
        if (!d || !d.billNo) return null;
        return {
          billNo: d.billNo,
          total: d.totalAmount || 0,
          paid: d.totalPaid || 0,
          items: (d.itemList || []).filter(function (it) { return !it.voided; }).map(function (it) {
            return {
              pluId: it.pluId,
              cn: it.pluName2 || it.pluName1 || '',
              en: it.pluName1 || it.pluName2 || '',
              qty: it.quantity || 1,
              amount: typeof it.amount === 'number' ? it.amount : (it.price || 0) * (it.quantity || 1),
              opts: (it.attrs || []).map(function (a) {
                return String(a.pluName2 || a.pluName1 || '').replace(/^\[\*\]/, '') + (a.quantity > 1 ? '×' + a.quantity : '');
              }),
              notes: it.notes || '',
            };
          }),
        };
      });
  }

  /* -------------------------------------------------------------- item lines */
  // One option (attr) under a parent item, shaped like the accepted orders.
  function attr(parentPlu, raw, qty) {
    var a = clone(raw);
    var name = String(a.pluName2 || '');
    if (name && name.indexOf('[*]') !== 0) a.pluName2 = '[*]' + name;
    a.subKeyId = parentPlu + '-' + a.pluId;
    a.quantity = qty;
    a.amount = r2((a.price || 0) * qty);
    a.shopPrice = a.price || 0;
    a.checked = true;
    a.selected = 0;
    a.gstAmount = 0;
    return a;
  }

  // One line on the bill, from the item's full POS object.
  //   o = { qty, priceIndex?, unit?, attrs?, notes? }
  function line(raw, o) {
    var it = clone(raw);
    var unit = typeof o.unit === 'number' ? o.unit : raw.price;
    var attrs = o.attrs || [];
    var misc = r2(attrs.reduce(function (s, a) { return s + (a.price || 0) * a.quantity; }, 0));
    var qty = o.qty || 1;
    var each = r2(unit + misc);
    it.priceIndex = o.priceIndex || 0;
    it.shopPrice = unit;
    it.price = each;
    it.misc = misc;
    it.totalMisc = misc;
    it.quantity = qty;
    it.amount = r2(each * qty);
    it.attrs = attrs;
    it.notes = o.notes || '';
    it.gstAmount = gstOf(unit * qty, raw);              // base only, not options
    it.itemId = uid();
    it.newAddedItem = true;
    it.deliveredQty = 0;
    it.status = 1;
    it.includeGst = true;
    it.parentId = raw.catId;
    it.attrDiscountableAmount = r2(misc * qty);
    it.attrPointableAmount = r2(misc * qty);
    it.attrPtAndDiscAmount = r2(misc * qty);
    it.discountableAmount = 0;
    it.pointableAmount = it.amount;
    it.ptAndDiscAmount = 0;
    return it;
  }

  // 半份: POS keeps the half price as a priceList entry named 半份（Half）.
  function halfIndex(raw) {
    var pl = raw.priceList || [];
    for (var i = 0; i < pl.length; i++) if (pl[i].subName && /半份|half/i.test(pl[i].subName)) return i;
    return -1;
  }

  // Find a set-menu option by the name the wizard shows ("全辣", "银鲈鱼", "冰粉")
  // among ArmLoop's option groups ("全辣锅底", "银鲈⻥", ...). Prefer the group
  // at the same position; fall back to any group.
  function findOpt(liveGroups, groupIdx, name) {
    var n = MS._norm(name);
    var order = [groupIdx].concat(liveGroups.map(function (_, i) { return i; }).filter(function (i) { return i !== groupIdx; }));
    var tests = [
      function (p) { return p === n; },
      function (p) { return p.indexOf(n) >= 0 || n.indexOf(p) >= 0; },
    ];
    for (var t = 0; t < tests.length; t++) {
      for (var k = 0; k < order.length; k++) {
        var g = liveGroups[order[k]];
        if (!g) continue;
        var hit = (g.attrs || []).filter(function (a) {
          return tests[t](MS._norm(a.pluName2)) || tests[t](MS._norm(a.pluName1));
        })[0];
        if (hit) return hit;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------- build */
  // cart: the app's cart lines. ctx: { table, pax, lang, menu, fees:{potFee,coldBase,upgrade},
  //   condimentQty, appTotal }
  // Returns { body, bill, total, warnings[], missingFees[] } or throws with
  // err.unmapped = [names] when something in the cart has no POS item.
  function build(cart, ctx) {
    var s = shop(), M = ctx.menu;
    var isTest = ctx.table === TEST_TABLE || MS.env === 'sandbox';
    var items = [], unmapped = [], missingFees = [], warnings = [];

    function rawOf(item) { return item && (item._raw || (item.plu && MS.rawPlu(item.plu))); }
    function need(raw, label) { if (!raw) unmapped.push(label); return raw; }
    function fee(key, label, amount, qty) {
      var plu = MS.feePlu && MS.feePlu[key];
      var raw = plu && MS.rawPlu(plu);
      if (raw) { items.push(line(raw, { qty: qty || 1 })); return; }
      missingFees.push({ key: key, label: label, amount: amount, qty: qty || 1 });
    }

    cart.forEach(function (c) {
      var r = c.ref || {};
      if (r.kind === 'addon') {
        var a = (M.addons || []).filter(function (x) { return x.id === r.id; })[0];
        var raw = need(rawOf(a), c.title);
        if (!raw) return;
        if (r.por === 'half') {
          var hi = halfIndex(raw);
          if (hi < 0) { unmapped.push(c.title + '（半份）'); return; }
          items.push(line(raw, { qty: c.qty, priceIndex: hi, unit: raw.priceList[hi].price }));
        } else {
          items.push(line(raw, { qty: c.qty }));
        }

      } else if (r.kind === 'package') {
        var p = (M.packages || []).filter(function (x) { return x.id === r.id; })[0];
        var praw = need(rawOf(p), c.title);
        if (!praw) return;
        var lg = (p && p.liveGroups) || [];
        var attrs = [];
        if (p.fixed) {
          if (r.up && p.drinkUp) {
            var d = findOpt(lg, 0, p.drinkUp.cn);
            if (d) attrs.push(attr(praw.pluId, d, 1)); else unmapped.push(c.title + ' · ' + p.drinkUp.cn);
          }
        } else {
          (p.groups || []).forEach(function (g, gi) {
            var sel = (r.sel || {})[gi];
            if (sel == null) return;
            var picks = typeof sel === 'string' ? [[sel, 1]] : Object.keys(sel).map(function (k) { return [k, sel[k]]; });
            picks.forEach(function (pk) {
              var o = findOpt(lg, gi, pk[0]);
              if (o) attrs.push(attr(praw.pluId, o, pk[1])); else unmapped.push(c.title + ' · ' + pk[0]);
            });
          });
        }
        for (var q = 0; q < c.qty; q++) items.push(line(praw, { qty: 1, attrs: clone(attrs), notes: '' }));

      } else if (r.kind === 'fish') {
        var f = (M.fish || []).filter(function (x) { return x.id === r.id; })[0];
        var fraw = need(rawOf(f), c.title);
        if (!fraw) return;
        var b = r.broth ? (M.broths || []).filter(function (x) { return x.id === r.broth; })[0] : null;
        // Spice / cook method exist in POS only at showType 0, so they travel as
        // a note on the fish line (see handover §5). Broth goes as its own line.
        var note = [r.dish, r.numb + '·' + r.spicy, r.cook, b ? ('锅底:' + b.cn) : ''].filter(Boolean).join(' · ');
        for (var n = 0; n < c.qty; n++) {
          items.push(line(fraw, { qty: 1, notes: note }));
          if (r.mode === 'direct') {
            var baseRaw = MS.rawPlu(r.dish === '酸菜鱼' ? '0119' : '0116');   // 酸菜锅底 / 全辣锅底
            if (baseRaw) items.push(line(baseRaw, { qty: 1 }));
            fee('coldBase', '锅底费（' + r.dish + '）', ctx.fees.coldBase);
            if (b) {
              var braw = rawOf(b);
              if (braw) items.push(line(braw, { qty: 1, notes: '升级鸳鸯' }));
              fee('upgrade', '升级鸳鸯锅', ctx.fees.upgrade);
            }
          } else {
            var br = rawOf(b);
            if (br) items.push(line(br, { qty: 1 })); else if (b) unmapped.push('锅底 ' + b.cn);
            fee('potFee', '锅底费', ctx.fees.potFee);
          }
        }

      } else if (r.kind === 'hotpot') {
        var bs = (r.broths || []).map(function (id) { return (M.broths || []).filter(function (x) { return x.id === id; })[0]; });
        for (var h = 0; h < c.qty; h++) {
          bs.forEach(function (bb, i) {
            var hr = rawOf(bb);
            if (hr) items.push(line(hr, { qty: 1, notes: i === 0 ? (r.potName || '') : '' }));
            else unmapped.push('锅底 ' + (bb ? bb.cn : r.broths[i]));
          });
          fee('potFee', '锅底费（' + (r.potName || '单点火锅') + '）', ctx.fees.potFee);
        }

      } else {
        unmapped.push(c.title);
      }
    });

    if (ctx.condimentQty > 0) {
      var cr = need(rawOf(M.condiment) || MS.rawPlu('0105'), '调料（每位）');
      if (cr) items.push(line(cr, { qty: ctx.condimentQty }));
    }

    if (unmapped.length) {
      var err = new Error('Not orderable via POS: ' + unmapped.join(', '));
      err.unmapped = unmapped;
      throw err;
    }

    if (isTest) items.forEach(function (it) { it.notes = it.notes ? TEST_NOTE + ' · ' + it.notes : TEST_NOTE; });

    var total = r2(items.reduce(function (s2, it) { return s2 + it.amount; }, 0));
    var gst = items.reduce(function (s2, it) { return s2 + it.gstAmount; }, 0);
    var feeOwed = r2(missingFees.reduce(function (s2, m) { return s2 + (m.amount || 0) * m.qty; }, 0));
    if (typeof ctx.appTotal === 'number' && Math.abs(r2(total + feeOwed) - r2(ctx.appTotal)) > 0.009) {
      warnings.push('POS total ' + total + ' + fees not in POS ' + feeOwed + ' != app total ' + ctx.appTotal);
    }

    var now = new Date(), ts = now.getTime();
    var table = ctx.table, tn = tabNo(table);
    var notes = [isTest ? TEST_NOTE : '', '扫码点餐 桌' + table];
    if (missingFees.length) {
      notes.push('请在柜台加收：' + missingFees.map(function (m) {
        return m.label + ' $' + (m.amount != null ? m.amount.toFixed(2) : '?') + (m.qty > 1 ? ' ×' + m.qty : '');
      }).join('、') + '（POS 尚无此品项）');
    }
    var cartId = uid(), billNo = uid(), deviceId = uid();
    var stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    var hm = pad(now.getHours()) + ':' + pad(now.getMinutes());

    var bill = Object.assign(clone(BILL_STATIC), {
      cartId: cartId, deviceId: '', lastUpdated: ts, createdTimestamp: 0,
      originalAmount: total, totalAmount: total, newItemAmount: total,
      persons: ctx.pax || 1, plateNo: tn, plateName: table,
      gst: r2(gst), tax1: gst, itemList: items, transactionId: uid(),
      notes: notes.filter(Boolean).join(' · '),
      totalPointableAmount: total, totalPointedAmount: total,
      ordScan: s.ordScan, shopId: s.shopId, spotId: s.spotId, shopName: 'Sea &Spice',
      device: deviceId, terminalId: s.terminalId, lang: ctx.lang || 'cn',
      customizeServiceNo: '桌 ' + table,
      timeLine: Math.floor(ts / 1000),
      onlineInfo: {
        deliveryType: '1', deliveryZone: '', express: 0,
        pickUp: stamp + 'T' + hm, pickUpTime: stamp + ' ' + hm + ':00', pickUpTimeDesp: hm + ' ' + pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear(),
        startTime: '', endTime: '', hoursBooked: 2, people: ctx.pax || 1, adult: ctx.pax || 1, children: 0,
        tabNo: tn, placeNo: '', notes: ', ', pickUpTimeWithZone: now.toISOString(), actionTimer: 0,
        timeLine: Math.floor(ts / 1000),
      },
      clientInfo: {
        firstName: 'Table', lastName: table, email: '', address: '',
        mobilePhone: PLACEHOLDER_PHONE, mobile: PLACEHOLDER_PHONE, zipCode: 0, countryCode: '+61', scanUrl: '', ordScan: -1,
      },
    });

    var body = {
      billNo: billNo, orderId: billNo, billType: 2,
      description: '扫码点餐 桌' + table, billDesc: '桌 ' + table,
      amount: total, currency: 'AUD',
      shopId: s.shopId, terminalId: s.terminalId, spotId: s.spotId, siteId: s.siteId, ordScan: s.ordScan,
      deviceId: deviceId, requiredBy: 'pos', payType: '301',
      orderType: 2, orderStatus: 0,
      // Its presence makes the POS answer SYNC-BEFORE-PAID: ticket now, pay at the counter.
      sendOrderWhenPaid: 'false',
      surchargeType: 0, merchantSurcharge: '0', merchantOrderId: billNo,
      cartId: cartId, createdTimestamp: ts, lastUpdated: ts,
      firstName: 'Table', lastName: table, phoneNumber: PLACEHOLDER_PHONE, email: '',
      billInfo: b64(JSON.stringify(bill)),
    };

    if (warnings.length) console.warn('[PosOrder]', warnings.join(' | '));
    return { body: body, bill: bill, total: total, warnings: warnings, missingFees: missingFees, test: isTest };
  }

  /* ------------------------------------------------------------------ submit */
  // Resolves { ok, rtn, msg, transactionId, commands, billNo }.
  // ok means the POS accepted it AND will send it to the kitchen before payment.
  function submit(body) {
    return MS._call(V1 + '/pro/pos/payOrder', body).then(function (j) {
      var m = (j && j.map) || {};
      var commands = String(m.commands || '');
      var ok = !!j && j.code === 200 && typeof m.rtn === 'number' && m.rtn > 0 && /SYNC-BEFORE-PAID/.test(commands);
      var res = { ok: ok, rtn: m.rtn, msg: m.disp_msg || m.dispMsg || (j && j.message) || '', transactionId: m.transactionId || '', commands: commands, billNo: body.billNo };
      (ok ? console.info : console.error)('[PosOrder] payOrder', res);
      return res;
    });
  }

  window.PosOrder = {
    shopStatus: shopStatus,
    tableBill:  tableBill,
    build:      build,
    submit:     submit,
    TEST_TABLE: TEST_TABLE,
    TEST_NOTE:  TEST_NOTE,
    live:       function () { return MS.live(); },
  };
})();
