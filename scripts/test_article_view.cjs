/** Renderer integration checks. Run with: electron scripts/test_article_view.cjs */
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {installArticleOverlay}=require('../desktop/article-overlay.cjs');
const {publicURL,publicRequest}=require('../desktop/article-url.cjs');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'paper-web-renderer-')));
const fixture=`<!doctype html><html><head><title>Interactive research</title><style>body{font:18px Arial;max-width:720px;margin:60px auto;color:#514640}figure{background:#eee;padding:30px}input{width:100%}</style></head><body><nav><p>Same paragraph outside article.</p></nav><article><h1>Interactive research</h1><p id="intro">We study the <a href="#method" id="footnote">original research evidence</a> carefully.</p><h2 id="method">Method</h2><figure><input id="slider" type="range" min="0" max="10" value="3"><output id="value">3</output><svg width="400" height="100"><circle id="point" cx="100" cy="50" r="15"/></svg><figcaption>Measured feature strength.</figcaption></figure><p id="later">A final scientific paragraph.</p><pre><code>const x = 3;</code></pre><div style="height:1200px"></div></article><script>slider.oninput=()=>{value.textContent=slider.value;point.setAttribute('cx',slider.value*30)};footnote.addEventListener('click',()=>document.body.dataset.clicked='yes')</script></body></html>`;
const blocks=[
  {index:1,source:'Interactive research',html:'<h1>交互式研究</h1>',tag:'h1',translated:true},
  {index:2,source:'We study the original research evidence carefully.',html:'<p>我们仔细研究<a href="#method">原始研究证据</a>。</p>',tag:'p',translated:true},
  {index:3,source:'Method',html:'<h2>方法</h2>',tag:'h2',translated:true},
  {index:4,source:'3 Measured feature strength.',html:'<p>3 测得的特征强度。</p>',tag:'figure',translated:true},
  {index:5,source:'A final scientific paragraph.',html:'<p>最后一段科学论述。</p>',tag:'p',translated:true},
  {index:6,source:'const x = 3;',html:'<pre><code>const x = 3;</code></pre>',tag:'pre',translated:true,code:true},
  {index:7,source:'A dynamically rendered qualification.',html:'<p>动态渲染的限定条件。</p>',tag:'p',translated:true},
  {index:8,source:'A paragraph no longer on this page.',html:'<p>不应错误出现。</p>',tag:'p',translated:true}
];
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:950,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}}),wc=win.webContents;
 const run=code=>wc.executeJavaScriptInIsolatedWorld(1004,[{code}]);
 try{
  await wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(fixture));
  let result=await run(`(${installArticleOverlay.toString()})(${JSON.stringify({mode:'chinese',blocks,highlights:[]})})`);
  assert.equal(result.matched,5);assert.equal(result.total,7);
  assert.equal(await wc.executeJavaScript("typeof require"),'undefined');assert.equal(await wc.executeJavaScript('typeof desktop'),'undefined');
  assert.equal(await run("document.querySelector('#intro').classList.contains('pa-original-hidden')"),true);
  assert.equal(await run("document.querySelector('figure').classList.contains('pa-original-hidden')"),false);
  await wc.executeJavaScript("document.querySelector('.pa-translation a[href=\"#method\"]').click()");await new Promise(resolve=>setTimeout(resolve,150));assert.ok(await run('scrollY>150'));await run('scrollTo(0,0)');
  await wc.executeJavaScript("slider.value=8;slider.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await wc.executeJavaScript("document.querySelector('output').textContent"),'8');assert.equal(await wc.executeJavaScript("point.getAttribute('cx')"),'240');
  await run("globalThis.__paperArchiveArticle.configure({mode:'bilingual'})");
  assert.equal(await run("getComputedStyle(document.querySelector('#intro')).display==='none'"),false);
  assert.equal(await run("document.querySelectorAll('.pa-translation:not([hidden])').length"),5);
  await wc.executeJavaScript("document.querySelector('article').insertAdjacentHTML('beforeend','<p>A dynamically rendered qualification.</p>')");
  await new Promise(resolve=>setTimeout(resolve,800));
  result=await run('globalThis.__paperArchiveArticle.state()');assert.equal(result.matched,6);
  const found=await run("globalThis.__paperArchiveArticle.find('科学',false,false)");assert.equal(found.total,1);
  await run("globalThis.__paperArchiveArticle.configure({mode:'original'})");assert.equal(await run("document.querySelectorAll('.pa-translation:not([hidden])').length"),0);
  await wc.executeJavaScript("document.querySelector('#footnote').click()");assert.equal(await wc.executeJavaScript('document.body.dataset.clicked'),'yes');
  await run("globalThis.__paperArchiveArticle.configure({mode:'chinese'})");
  await new Promise(resolve=>setTimeout(resolve,250));
  await run("(()=>{const el=document.querySelector('.pa-translation[data-pa-block=\"5\"]'),range=new Range();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range)})()");
  const selected=(await run('globalThis.__paperArchiveArticle.state()')).selection;assert.equal(selected.page,5);assert.equal(selected.language,'chinese');assert.ok(selected.text.includes('科学'));
  await run("globalThis.__paperArchiveArticle.paint([{page:5,language:'chinese',text:'科学'}])");assert.equal(await run("CSS.highlights.get('pa-annotations').size"),1);
  await run('globalThis.__paperArchiveArticle.clearSelection()');
  const png=await wc.capturePage();fs.writeFileSync('/tmp/paper-archive-web-overlay.png',png.toPNG());
  await wc.executeJavaScript("document.querySelector('#later').firstChild.data='This source paragraph was revised.'");await new Promise(resolve=>setTimeout(resolve,700));assert.equal(await run("document.querySelector('.pa-translation[data-pa-block=\"5\"]')===null"),true);
  await run('globalThis.__paperArchiveArticle.destroy()');assert.equal(await run("document.querySelectorAll('.pa-translation').length"),0);
  assert.equal(await run("document.querySelectorAll('.pa-original-hidden').length"),0);
  await wc.executeJavaScript(`document.querySelector('article').insertAdjacentHTML('beforeend','<p id="equation">A small equation <span class="katex"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span>.</p>')`);
  result=await run(`(${installArticleOverlay.toString()})(${JSON.stringify({mode:'chinese',blocks:[{index:9,source:'A small equation MATH x^2 END .',html:'<p>小方程 x²。</p>',translated:true,tag:'p'}],highlights:[]})})`);assert.equal(result.matched,1);
  await wc.executeJavaScript("document.querySelector('#equation annotation').firstChild.data='x^3'");await new Promise(resolve=>setTimeout(resolve,700));assert.equal((await run('globalThis.__paperArchiveArticle.state()')).matched,0);
  await run('globalThis.__paperArchiveArticle.destroy()');
  for(const url of ['http://127.0.0.1:8767','https://localhost','https://10.0.0.1','https://[::1]','https://[::ffff:127.0.0.1]','file:///etc/passwd','javascript:alert(1)','https://user:password@example.com','https://example.com:9999'])assert.equal(publicURL(url),false,url);
  assert.equal(await publicRequest('https://example.com',async()=>[{address:'192.168.1.1',family:4}]),false);
  assert.equal(await publicRequest('https://example.com',async()=>[{address:'93.184.216.34',family:4}]),true);
  assert.equal(await publicRequest('https://example.com',async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]),false);
  console.log('PASS: live controls, original handlers, inline Chinese/bilingual/original, dynamic DOM, matching coverage, search, teardown and private-network isolation');
  win.destroy();app.quit();
 }catch(error){console.error(error);win.destroy();app.exit(1);}
});
