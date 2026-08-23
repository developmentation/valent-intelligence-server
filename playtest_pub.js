const { chromium } = require('playwright');
const SS = 'C:/Users/Syma/AppData/Local/Temp/claude/c--dev-valent-intelligence-claude/cd551387-9158-4eed-afa0-ec293ca2b68c/scratchpad/';
(async () => {
  const base = process.env.BASE, pw = process.env.PW;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const log = (...a) => console.log(...a);

  // --- admin context: log in, curate, publish ---
  const admin = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const p = await admin.newPage();
  await p.goto(base + '/login?next=/curate', { waitUntil: 'domcontentloaded' });
  await p.fill('input[name=password]', pw);
  await Promise.all([p.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), p.click('button')]);
  await p.waitForSelector('.sess', { timeout: 20000 });
  const nSess = await p.$$eval('.sess', els => els.length);
  log('sessions listed:', nSess);

  // pick the 2 sessions with the most records (likely today's big ones) — check their boxes
  await p.$$eval('.sess', els => {
    els.slice(0, 3).forEach(el => { const c = el.querySelector('input'); if (!c.checked) el.click(); });
  });
  await p.waitForSelector('#editor:not(.hidden)', { timeout: 10000 });
  await p.fill('#title', 'TEST — overnight publication check');
  await p.waitForFunction(() => document.querySelectorAll('#gallery .g').length > 0, { timeout: 25000 }).catch(() => {});
  const galN = await p.$$eval('#gallery .g', els => els.length);
  log('gallery items:', galN);

  // exclude the first item; record its path + a kept path
  const paths = await p.$$eval('#gallery .g', els => els.map(e => e.dataset.path));
  const excludedPath = paths[0], keptPath = paths.find(x => x !== paths[0]);
  await p.click('#gallery .g'); // exclude first
  await p.screenshot({ path: SS + 'pub_curate.png' });

  await p.click('#btnPublish');
  await p.waitForSelector('#pubLink', { timeout: 15000 });
  const link = (await p.$eval('#pubLink', e => e.textContent)).trim();
  const uuid = link.split('/').pop();
  log('PUBLISHED link:', link);
  log('excludedPath:', excludedPath, '| keptPath:', keptPath);

  // --- public context: NO auth cookies ---
  const pub = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const q = await pub.newPage();
  q.on('console', m => { if (m.type() === 'error') log('  [public console.error]', m.text()); });
  q.on('pageerror', e => log('  [public pageerror]', e.message));
  const resp = await q.goto(link, { waitUntil: 'domcontentloaded' });
  await q.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
  await q.waitForFunction(() => document.querySelectorAll('#grid .cell').length > 0, { timeout: 15000 }).catch(() => {});
  const h1 = await q.$eval('h1', e => e.textContent).catch(() => '(no h1)');
  const gridN = await q.$$eval('#grid .cell', els => els.length).catch(() => 0);
  const stats = await q.$eval('.stats', e => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(no stats)');
  log('PUBLIC view: status', resp.status(), '| h1:', h1, '| grid cells:', gridN);
  log('  stats:', stats);
  await q.waitForTimeout(1500); // let map tiles + thumbs settle for the screenshot
  await q.screenshot({ path: SS + 'pub_public.png', fullPage: true });

  // exclusion enforcement: excluded media must 404, a kept one must 200 — from the NO-AUTH context
  const chk = async (rel) => { const r = await pub.request.get(base + '/pub/' + uuid + '/media/' + rel); return r.status(); };
  const exStatus = await chk(excludedPath);
  const keptStatus = keptPath ? await chk(keptPath) : 'n/a';
  log('EXCLUSION enforce: excluded ->', exStatus, '(want 404) | kept ->', keptStatus, '(want 200)');

  // AUDIO must NOT be reachable or referenced: /api/pub lists no .aac, and a guessed audio path 404s.
  const apiPub = await (await pub.request.get(base + '/api/pub/' + uuid)).json();
  const anyAac = (apiPub.media || []).some(m => /\.aac$/i.test(m.url) || /\.aac$/i.test(m.filename || ''));
  const memberSid = (apiPub.legs || [])[0] && apiPub.legs[0].session_id;
  const audioGuess = memberSid ? `${memberSid}/audio/${memberSid}.040_000000.aac` : null;
  const audioStatus = audioGuess ? await chk(audioGuess) : 'n/a';
  log('AUDIO closed: /api/pub lists .aac ->', anyAac, '(want false) | guessed .aac ->', audioStatus, '(want 404)');

  // SLIDESHOW: open it from the public page and confirm it renders (stage, place, filmstrip).
  await q.click('.playbtn');
  await q.waitForSelector('#show.open', { timeout: 8000 }).catch(() => {});
  await q.waitForFunction(() => document.querySelectorAll('#swFilms .thumb').length > 0, { timeout: 8000 }).catch(() => {});
  await q.waitForFunction(() => document.querySelectorAll('#show .layer.on').length > 0, { timeout: 10000 }).catch(() => {});
  await q.waitForTimeout(1200);
  const showOpen = await q.$eval('#show', e => e.classList.contains('open')).catch(() => false);
  const swPlace = await q.$eval('#swPlace', e => e.textContent).catch(() => '(none)');
  const swProg = await q.$eval('#swProg', e => e.textContent).catch(() => '(none)');
  const swThumbs = await q.$$eval('#swFilms .thumb', els => els.length).catch(() => 0);
  const swStageOn = await q.$$eval('#show .layer.on', els => els.length).catch(() => 0);
  log('SLIDESHOW: open', showOpen, '| place:', swPlace, '| progress:', swProg, '| thumbs:', swThumbs, '| stage-layer-on:', swStageOn);
  await q.screenshot({ path: SS + 'pub_slideshow.png' });

  // --- unpublish via admin API, then public must 404 ---
  await admin.request.patch(base + '/admin/publications/' + uuid, { data: { published: false } });
  const afterPub = await pub.request.get(base + '/api/pub/' + uuid);
  const afterPage = await pub.request.get(base + '/publish/' + uuid);
  log('AFTER UNPUBLISH: /api/pub ->', afterPub.status(), '(want 404) | /publish page ->', afterPage.status(), '(want 404)');

  // cleanup: delete the test publication
  const del = await admin.request.delete(base + '/admin/publications/' + uuid);
  log('cleanup delete ->', del.status());

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
