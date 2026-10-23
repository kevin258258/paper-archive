/** Share the reader's existing reviewed translations with the original webpage.
 * Citations are part of the source on BOTH sides; TeX remains identifiable even
 * when the reader's KaTeX HTML omits its MathML annotation.
 */
export function buildWebBlocks(blocks,renderMarkdown,baseURL=document.baseURI){
  function html(text){
    const template=document.createElement('template');template.innerHTML=renderMarkdown(text||'',true).trim();
    const formulas=[];
    (text||'').replace(/```[\s\S]*?```|`[^`\n]+`|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|(?<![\\\w])\$([^\n$]+?)\$(?!\w)/g,(match,a,b,c,d)=>{if(!match.startsWith('`'))formulas.push(a??b??c??d);return match;});
    let i=0;template.content.querySelectorAll('.katex,math,mjx-container,d-math').forEach(n=>{if(formulas[i]!==undefined)n.setAttribute('data-pa-tex',formulas[i++]);});
    return template;
  }
  return blocks.map(b=>{
    const original=html(b.original),translated=html(b.chinese),tag=original.content.firstElementChild?.tagName.toLowerCase()||'';
    for(const link of original.content.querySelectorAll('a[href*="#"]')){
      try{const url=new URL(link.getAttribute('href'),baseURL),base=new URL(baseURL);if(url.origin===base.origin&&url.pathname===base.pathname&&url.search===base.search)link.textContent=link.textContent.replace(/^(\s*§\s*)(?:\d+(?:\.\d+)*\s*|[A-Z](?:\.\d+)*[.\s]+)/,'$1');}catch{}
    }
    const prose=original.content.cloneNode(true);prose.querySelectorAll('.katex,math,mjx-container,d-math').forEach(n=>n.remove());
    original.content.querySelectorAll('.katex,math,mjx-container,d-math').forEach(n=>n.replaceWith(' MATH '+(n.getAttribute('data-pa-tex')||'UNKNOWN '+n.textContent)+' END '));
    const loading=text=>/^Loading(?:\s+(?:neuron\s+)?data)?(?:\.{3}|…)?$/i.test(text.trim());
    const table=prose.querySelector('table'),bodyRows=table?[...table.tBodies].flatMap(body=>[...body.rows]):[];
    const dynamic=loading(prose.textContent)||!!bodyRows.length&&bodyRows.every(row=>!row.textContent.trim()||loading(row.textContent))&&bodyRows.some(row=>loading(row.textContent));
    return {index:b.index,source:original.content.textContent,html:translated.innerHTML,translated:!!b.chinese,code:/^```/.test(b.original)||!prose.textContent.trim(),dynamic,tag};
  });
}
