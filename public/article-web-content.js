/** Share the reader's existing reviewed translations with the original webpage.
 * Citations are part of the source on BOTH sides; TeX remains identifiable even
 * when the reader's KaTeX HTML omits its MathML annotation.
 */
export function buildWebBlocks(blocks,renderMarkdown){
  function html(text){
    const template=document.createElement('template');template.innerHTML=renderMarkdown(text||'',true).trim();
    const formulas=[];
    (text||'').replace(/```[\s\S]*?```|`[^`\n]+`|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|(?<![\\\w])\$([^\n$]+?)\$(?!\w)/g,(match,a,b,c,d)=>{if(!match.startsWith('`'))formulas.push(a??b??c??d);return match;});
    let i=0;template.content.querySelectorAll('.katex,math,mjx-container,d-math').forEach(n=>{if(formulas[i]!==undefined)n.setAttribute('data-pa-tex',formulas[i++]);});
    return template;
  }
  return blocks.map(b=>{
    const original=html(b.original),translated=html(b.chinese),tag=original.content.firstElementChild?.tagName.toLowerCase()||'';
    original.content.querySelectorAll('.katex,math,mjx-container,d-math').forEach(n=>n.replaceWith(' MATH '+(n.getAttribute('data-pa-tex')||'UNKNOWN '+n.textContent)+' END '));
    return {index:b.index,source:original.content.textContent,html:translated.innerHTML,translated:!!b.chinese,code:/^```/.test(b.original)||/^\s*\$\$[\s\S]*\$\$\s*$/.test(b.original),tag};
  });
}
