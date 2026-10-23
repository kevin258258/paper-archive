/** MHTML serializes DOM styles, but loses shadow-root adoptedStyleSheets. */
async function articleSnapshotStyles(prepare){
  let count=0;const pending=[];
  function visit(root){
    for(const host of root.querySelectorAll('*')){
      const shadow=host.shadowRoot;if(!shadow)continue;
      if(prepare){
        const rules=[];for(const sheet of [...shadow.styleSheets,...shadow.adoptedStyleSheets]){try{for(const rule of sheet.cssRules)rules.push(rule.cssText.replace(/url\(([^)]+)\)/g,(match,url)=>{try{return 'url('+JSON.stringify(new URL(url.replace(/^['"]|['"]$/g,''),sheet.href||document.baseURI).href)+')';}catch{return match;}}));}catch{}}
        if(rules.length&&!shadow.querySelector('[data-pa-snapshot-style]')){
          // Chromium drops <style> from serialized shadow trees too. A data
          // stylesheet remains self-contained and survives an MHTML round trip.
          const link=document.createElement('link');link.rel='stylesheet';link.dataset.paSnapshotStyle='';link.href='data:text/css;charset=utf-8,'+encodeURIComponent(rules.join('\n'));
          pending.push(new Promise(resolve=>{const timer=setTimeout(resolve,2000);link.onload=link.onerror=()=>{clearTimeout(timer);resolve();};}));shadow.append(link);count++;
        }
      }else shadow.querySelectorAll('[data-pa-snapshot-style]').forEach(n=>{n.remove();count++;});
      visit(shadow);
    }
  }
  visit(document);await Promise.all(pending);return count;
}
module.exports={articleSnapshotStyles};
