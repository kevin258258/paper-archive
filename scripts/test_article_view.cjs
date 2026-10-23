/** Offscreen native regression tests; no user data or external network access. */
const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {installArticleOverlay}=require('../desktop/article-overlay.cjs');
const {articleSnapshotStyles}=require('../desktop/article-snapshot.cjs');
const {publicURL,publicRequest}=require('../desktop/article-url.cjs');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8'),delay=ms=>new Promise(r=>setTimeout(r,ms));
const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'paper-web-renderer-')),snapshotPath=path.join(testDir,'source.mhtml');
app.setPath('userData',testDir);
const source=[
 [1,'# Interactive research','# 交互式研究'],
 [2,'We study the *original research evidence* carefully [[1](#ref-1)].','我们仔细研究*原始研究证据* [[1](#ref-1)]。'],
 [3,'## Method','## 方法'],
 [4,'Measured feature strength.','测得的特征强度。'],
 [5,'A final scientific paragraph.','最后一段科学论述。'],
 [6,'```js\nconst x = 3;\n```','```js\nconst x = 3;\n```'],
 [7,'A dynamically rendered qualification.','动态渲染的限定条件。'],
 [8,'A paragraph no longer on this page.','不应错误出现。'],
 [9,'A small equation $x^2$.','小方程 $x^2$。'],
 [10,'Published:','发布日期：'],
 [11,'November 20, 2025','2025 年 11 月 20 日'],
 [12,'Correspondence to: author@example.org.','通信请联系：author@example.org。'],
 [13,'A closed appendix paragraph.','折叠的附录正文。'],
 [14,'Evidence [smith2025] supports this result.','证据支持这一结果。'],
 [15,'A note follows.（注：A qualification.）','这里有注释。（注：一个限定条件。）'],
 [16,'- Short.\n- This second item is deliberately much longer in English.','- 第一项中文很长，也必须完整留在第一项。\n- 第二项。'],
 [17,'| Name | Result |\n| --- | --- |\n| First | One |\n| Second | Two |','| 名称 | 结果 |\n| --- | --- |\n| 第一 | 一 |\n| 第二 | 二 |'],
 [18,'[Source repository](https://example.org/source)','[源代码仓库](https://example.org/source)'],
 [19,'For $x^2$','对于 $x^2$：'],
 [20,'Use the original format.','使用原来的 `format`。'],
 [21,'A long English introduction before its evidence [smith2026].','简述 [smith2026]。'],
 [22,'An introductory statement.（注：A note.） Then the conclusion.','引言。（注：这里的中文注释比原文长得多，仍应完整地留在脚注里。）然后是结论。'],
 [25,'Loading neuron data…','正在载入神经元数据…'],
 [26,'$q^2$','公式：$q^2$'],
 [24,'We discuss [§ Method](#method).','我们讨论[§ 方法](#method)。'],
 [23,'A main claim.（注：A qualification with $z^2$ and [evidence](#ref-1).） Then a conclusion.','主张。包含 $z^2$ 和[证据](#ref-1)的重要限定条件，必须完整显示。然后是结论。']
].map(([index,original,chinese])=>({index,original,chinese}));
const fixture=`<!doctype html><html><head><title>Interactive research</title><style>body{font:18px Arial;max-width:720px;margin:60px auto;color:#514640}h1{font-size:40px;line-height:1.1}figure{background:#eee;padding:30px}input{width:100%}</style></head><body><d-title><h1 id="outside-title">Native header</h1></d-title><nav><a href="#method" id="toc">Method</a></nav><article><h1 id="title">Interactive research</h1><p id="intro">We study the <em>original research evidence</em> carefully <span class="citation">[<sup><a href="#ref-1" id="footnote">1</a></sup>]</span>.</p><h2 id="method">Method</h2><figure><input id="slider" type="range" min="0" max="10" value="3"><output id="value">3</output><svg width="400" height="100"><circle id="point" cx="100" cy="50" r="15"/></svg><figcaption>Measured feature strength.</figcaption></figure><p id="later">A final scientific paragraph.</p><pre><code>const x = 3;</code></pre><p id="equation">A small equation <span class="katex"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span>.</p><div>Published: <!-- -->November 20, 2025</div><p id="contact">Correspondence to: author@example.org.</p><details id="appendix"><summary>Appendix</summary><p id="appendix-body">A closed appendix paragraph.</p></details><p id="distill-cite">Evidence <d-cite key="smith2025"></d-cite> supports this result.</p><p id="distill-note">A note follows.<d-footnote>A qualification.</d-footnote></p><ul id="semantic-list"><li>Short.</li><li>This second item is deliberately much longer in English.</li></ul><table id="semantic-table"><thead><tr><th>Name</th><th>Result</th></tr></thead><tbody><tr><td>First</td><td>One</td></tr><tr><td>Second</td><td>Two</td></tr></tbody></table><a id="standalone-link" href="https://example.org/source">Source repository</a><p id="end-math">For <d-math>x^2</d-math></p><p id="added-code">Use the original format.</p><p id="citation-boundary">A long English introduction before its evidence <d-cite key="smith2026"></d-cite>.</p><p id="note-boundary">An introductory statement.<d-footnote>A note.</d-footnote> Then the conclusion.</p><p id="legacy-note">A main claim.<d-footnote>A qualification with <d-math id="legacy-math">z^2</d-math> and <a href="#ref-1" id="legacy-evidence">evidence</a>.</d-footnote> Then a conclusion.</p><p id="numbered-reference">We discuss <a href="#method">§ 1 Method</a>.</p><div style="height:1200px"></div><p id="ref-1">Reference 1</p></article><script>slider.oninput=()=>{value.textContent=slider.value;point.setAttribute('cx',slider.value*30)};footnote.addEventListener('click',()=>document.body.dataset.clicked='yes')</script></body></html>`;
app.whenReady().then(async()=>{
 const isolated=session.fromPartition('offline-article-test');isolated.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('data:')&&!details.url.startsWith('blob:')&&details.url!==require('node:url').pathToFileURL(snapshotPath).href}));
 const win=new BrowserWindow({show:false,width:1200,height:950,webPreferences:{session:isolated,offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}}),wc=win.webContents;
 const run=code=>wc.executeJavaScriptInIsolatedWorld(1004,[{code}]);
 try{
  await wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(fixture));
  await wc.executeJavaScript(`(()=>{
    for(const [selector,html,css] of [
      ['d-cite','<span class="citation">[1]</span>',':host{display:inline}.citation{display:inline;color:rgb(20, 40, 60)}'],
      ['d-footnote','<sup>1</sup><span class="note"><slot></slot></span>',':host{display:inline}.note{display:none}:host(:hover) .note{display:inline}']
    ]){const shadow=document.querySelector(selector).attachShadow({mode:'open'});shadow.innerHTML=html;const sheet=new CSSStyleSheet();sheet.replaceSync(css);shadow.adoptedStyleSheets=[sheet];}
  })()`);
  // Use the exact production Markdown renderer and payload builder, including
  // citations, CJK emphasis, autolinks and KaTeX's canonical TeX metadata.
  let markdown=read('public/reader.js');markdown=markdown.slice(markdown.indexOf('export const markdown='),markdown.indexOf('\n\nexport class Reader')).replace('export const markdown=','const markdown=');
  const builder=read('public/article-web-content.js').replace('export function buildWebBlocks','function buildWebBlocks');
  const payload=await run(`${read('node_modules/dompurify/dist/purify.min.js')}\n${read('node_modules/katex/dist/katex.min.js')}\n${read('node_modules/marked/lib/marked.umd.js')}\n(()=>{const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));${markdown}\n${builder}\nreturn buildWebBlocks(${JSON.stringify(source)},markdown);})()`);
  assert.equal(payload.find(b=>b.index===25).dynamic,true);assert.equal(payload.find(b=>b.index===26).code,true);
  const original=await run("(()=>{globalThis.originalTitle=document.querySelector('#title');globalThis.originalIntro=document.querySelector('#intro');globalThis.originalLink=document.querySelector('#footnote');globalThis.originalFormula=document.querySelector('.katex');globalThis.legacyParagraph=document.querySelector('#legacy-note');globalThis.legacyLink=document.querySelector('#legacy-evidence');globalThis.legacyMath=document.querySelector('#legacy-math');globalThis.legacyHTML=legacyParagraph.innerHTML;return {html:document.querySelector('article').innerHTML,lineHeight:getComputedStyle(originalTitle).lineHeight,fontSize:getComputedStyle(originalTitle).fontSize,elements:document.querySelector('article').querySelectorAll('*').length}})()");
  let result=await run(`(${installArticleOverlay.toString()})(${JSON.stringify({title:{original:'Native header',chinese:'原站标题'},baseURL:'https://research.example.org/article',mode:'chinese',blocks:payload,highlights:[]})})`);
  assert.equal(result.total,23);assert.equal(result.matched,21);assert.deepEqual(result.unmatched,[7,8]);
  assert.equal(await run("document.querySelector('#distill-cite').textContent.trim()"),'证据支持这一结果。');
  assert.equal(await run("document.querySelector('#distill-note d-footnote').textContent"),'一个限定条件。');
  assert.equal(await run("document.querySelector('#outside-title').textContent"),'原站标题');
  assert.deepEqual(await run("[...document.querySelector('#semantic-list').children].map(n=>n.textContent.trim())"),['第一项中文很长，也必须完整留在第一项。','第二项。']);
  assert.deepEqual(await run("[...document.querySelector('#semantic-table').rows].map(r=>[...r.cells].map(c=>c.textContent.trim()))"),[['名称','结果'],['第一','一'],['第二','二']]);
  assert.equal(await run("document.querySelector('#standalone-link').textContent.trim()"),'源代码仓库');
  assert.equal(await run("document.querySelector('#end-math').textContent.trim()"),'对于 x^2：');
  assert.equal(await run("document.querySelector('#added-code').textContent.trim()"),'使用原来的 format。');
  assert.equal(await run("document.querySelector('#citation-boundary').firstChild.data.trim()"),'简述');
  assert.equal(await run("document.querySelector('#note-boundary d-footnote').textContent"),'这里的中文注释比原文长得多，仍应完整地留在脚注里。');
  assert.equal(await run("document.querySelector('#note-boundary').firstChild.data"),'引言。');
  assert.equal(await run("document.querySelector('#legacy-note')===legacyParagraph&&document.querySelector('#legacy-evidence')===legacyLink&&document.querySelector('#legacy-math')===legacyMath"),true);
  assert.equal(await run("legacyParagraph.textContent.trim()"),'主张。包含 z^2 和证据的重要限定条件，必须完整显示。然后是结论。');
  assert.equal(await run("legacyParagraph.querySelector('d-footnote')"),null);
  assert.equal(await run("document.querySelector('#numbered-reference').textContent.trim()"),'我们讨论§ 方法。');
  assert.equal(await run('originalTitle.textContent.trim()'),'交互式研究');assert.ok(await run('originalIntro.textContent.startsWith("我们仔细研究")'));
  assert.equal(await run("document.querySelector('#intro')===originalIntro&&document.querySelector('#footnote')===originalLink&&document.querySelector('.katex')===originalFormula"),true);
  assert.equal(await run("getComputedStyle(originalTitle).lineHeight"),original.lineHeight);assert.equal(await run("getComputedStyle(originalTitle).fontSize"),original.fontSize);
  assert.equal(await run("document.querySelector('article').querySelectorAll('*').length"),original.elements-1);assert.equal(await run("document.querySelectorAll('.pa-translation,.pa-original-hidden').length"),0);
  assert.equal(await run("document.querySelector('#toc').textContent.trim()"),'方法');assert.equal(await run("document.querySelector('#appendix-body').textContent.trim()"),'折叠的附录正文。');assert.equal(await run("document.querySelector('#appendix').open"),false);
  assert.equal(await run("document.querySelector('#contact').textContent.trim()"),'通信请联系：author@example.org。');assert.equal(await run("document.querySelector('#contact a')"),null);
  assert.equal(await wc.executeJavaScript('typeof require'),'undefined');assert.equal(await wc.executeJavaScript('typeof desktop'),'undefined');
  await wc.executeJavaScript("slider.value=8;slider.dispatchEvent(new Event('input',{bubbles:true}))");assert.equal(await wc.executeJavaScript("value.textContent"),'8');assert.equal(await wc.executeJavaScript("point.getAttribute('cx')"),'240');
  await run("(()=>{const range=new Range();range.selectNodeContents(originalIntro);getSelection().removeAllRanges();getSelection().addRange(range)})()");
  const selected=(await run('globalThis.__paperArchiveArticle.state()')).selection;assert.equal(selected.page,2);assert.equal(selected.language,'chinese');assert.ok(selected.text.includes('研究'));
  await run("globalThis.__paperArchiveArticle.paint([{page:2,language:'chinese',text:'研究'}])");assert.equal(await run("CSS.highlights.get('pa-annotations').size"),2);await run('globalThis.__paperArchiveArticle.clearSelection()');
  const found=await run("globalThis.__paperArchiveArticle.find('附录',false,false)");assert.equal(found.total,1);assert.equal(await run("document.querySelector('#appendix').open"),true);
  await run("globalThis.__paperArchiveArticle.configure({mode:'bilingual'})");assert.equal(await run("originalTitle.textContent"),'Interactive research');assert.equal(await run("document.querySelectorAll('.pa-translation').length"),21);
  await run("globalThis.__paperArchiveArticle.configure({mode:'original'})");assert.equal(await run("legacyParagraph.querySelector('d-footnote')?.textContent"),'A qualification with z^2 and evidence.');assert.equal(await run('legacyParagraph.innerHTML'),await run('legacyHTML'));assert.equal(await run("document.querySelectorAll('.pa-translation').length"),0);assert.equal(await run("document.querySelector('#toc').textContent"),'Method');
  await wc.executeJavaScript("footnote.click()");assert.equal(await wc.executeJavaScript('document.body.dataset.clicked'),'yes');
  await run("globalThis.__paperArchiveArticle.configure({mode:'chinese'})");await wc.executeJavaScript("document.querySelector('article').insertAdjacentHTML('beforeend','<p>A dynamically rendered qualification.</p>')");await delay(500);assert.equal((await run('globalThis.__paperArchiveArticle.state()')).matched,22);
  await wc.executeJavaScript("document.querySelector('#later').firstChild.data='This source paragraph was revised.'");await delay(500);assert.equal(await run("document.querySelector('#later').textContent"),'This source paragraph was revised.');assert.ok((await run('globalThis.__paperArchiveArticle.state()')).unmatched.includes(5));
  await wc.executeJavaScript("document.querySelector('#equation annotation').firstChild.data='-x^2'");await delay(500);assert.ok((await run('globalThis.__paperArchiveArticle.state()')).unmatched.includes(9));assert.equal(await run("document.querySelector('#equation').textContent.startsWith('A small equation')"),true);
  // A changed formula in a legacy-note substitution must restore the source
  // prose while retaining the new formula, rather than showing stale Chinese.
  await wc.executeJavaScript("document.querySelector('#legacy-math').firstChild.data='-z^2'");await delay(500);
  assert.ok((await run('globalThis.__paperArchiveArticle.state()')).unmatched.includes(23));
  assert.equal(await run("legacyParagraph.textContent.startsWith('A main claim.')"),true);
  assert.equal(await run("document.querySelector('#legacy-math').textContent"),'-z^2');
  await wc.executeJavaScript("document.querySelector('#legacy-math').firstChild.data='z^2'");await delay(500);
  assert.equal(await run("legacyParagraph.textContent.trim()"),'主张。包含 z^2 和证据的重要限定条件，必须完整显示。然后是结论。');
  // A refreshed MHTML must contain the original text, and then configure must
  // translate again even though the payload has not changed.
  await run('globalThis.__paperArchiveArticle.reset()');assert.equal(await run('originalTitle.textContent'),'Interactive research');await run("globalThis.__paperArchiveArticle.configure({mode:'chinese'})");assert.equal(await run('originalTitle.textContent.trim()'),'交互式研究');
  await run('globalThis.__paperArchiveArticle.destroy()');assert.equal(await run('originalTitle.textContent'),'Interactive research');assert.equal(await run("document.querySelectorAll('[data-pa-block],.pa-translation').length"),0);assert.equal(await run("document.querySelector('#intro').hasAttribute('lang')"),false);
  assert.equal(await run("document.querySelector('#outside-title').textContent"),'Native header');
  assert.equal(await run(`(${articleSnapshotStyles.toString()})(true)`),2);
  await wc.savePage(snapshotPath,'MHTML');
  assert.equal(await run(`(${articleSnapshotStyles.toString()})(false)`),2);
  assert.equal(await run("document.querySelector('d-cite').shadowRoot.querySelector('style')"),null);
  await wc.loadFile(snapshotPath);
  assert.deepEqual(await run("(()=>{const el=document.querySelector('d-cite').shadowRoot.querySelector('.citation');return {display:getComputedStyle(el).display,color:getComputedStyle(el).color}})()"),{display:'inline',color:'rgb(20, 40, 60)'});
  // Simulate a legacy MHTML whose adopted styles were already lost.
  await run("document.querySelector('d-cite').shadowRoot.querySelectorAll('style').forEach(n=>n.remove())");
  await run(`(${installArticleOverlay.toString()})(${JSON.stringify({baseURL:'https://research.example.org/article',mode:'chinese',blocks:payload,highlights:[]})})`);
  assert.equal(await run("getComputedStyle(document.querySelector('d-cite').shadowRoot.querySelector('.citation')).display"),'inline');
  assert.equal(await run("document.querySelector('#end-math').textContent.trim()"),'对于 x^2：');
  for(const url of ['http://127.0.0.1:8767','https://localhost','https://10.0.0.1','https://[::1]','https://[::ffff:127.0.0.1]','file:///etc/passwd','javascript:alert(1)','https://user:password@example.com','https://example.com:9999'])assert.equal(publicURL(url),false,url);
  assert.equal(await publicRequest('https://example.com',async()=>[{address:'192.168.1.1',family:4}]),false);assert.equal(await publicRequest('https://example.com',async()=>[{address:'93.184.216.34',family:4}]),true);assert.equal(await publicRequest('https://example.com',async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]),false);
  console.log('PASS: direct text replacement, unchanged element identity/styles/controls/formulas, citations, email autolinks, collapsed content/TOC, exact restore, bilingual, annotations, search, dynamic source invalidation, semantic list/table/citation boundaries, legacy note completeness, snapshot shadow styles and isolation');win.destroy();app.quit();
 }catch(error){console.error(error);win.destroy();app.exit(1);}
});
