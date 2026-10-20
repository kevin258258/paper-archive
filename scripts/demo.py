"""Generate clearly labelled synthetic papers in a new directory. No network."""
import argparse
from pathlib import Path
import json
import fitz
import yaml
parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True)
args=parser.parse_args()
root=Path(args.output).expanduser().resolve()
if root.exists() and any(root.iterdir()):
    parser.error('Choose a new or empty directory; existing libraries are never modified.')
root.mkdir(parents=True,exist_ok=True)
domains=[('01','计算与学习'),('02','视觉与表征'),('03','评估与推理')]
titles=[('Depth & Computation','深度与计算'),('Learning to Grow','学习与生长'),('The Shape of Memory','记忆的形状'),('Paths Through a Network','网络中的路径'),('Seeing in Context','语境中的视觉'),('A Shared Representation','共享表征'),('Alignment by Design','对齐的设计'),('From Pixels to Concepts','从像素到概念'),('Measuring Generalization','衡量泛化'),('Reasoning in Steps','分步推理'),('Beyond a Single Score','分数之外'),('Questions for Tomorrow','留给明天的问题')]
for i,(en,cn) in enumerate(titles):
    ident,name=domains[i//4];folder=root/'10-领域'/f'{ident}-{name}'/f'demo-{i+1:02}'
    folder.mkdir(parents=True)
    doc=fitz.open();page=doc.new_page(width=595,height=842)
    page.insert_text((52,55),'PAPER ARCHIVE / SYNTHETIC DEMO',fontsize=10)
    page.insert_textbox(fitz.Rect(52,160,540,340),en,fontsize=34,fontname='hebo')
    page.draw_line((52,390),(540,390),color=(.3,.3,.3),width=.7)
    for n in range(13):page.draw_line((52,470+n*15),(510-(n%3)*45,470+n*15),color=(.65,.65,.65),width=2)
    page.insert_text((52,780),'Demo content only. No research claims.',fontsize=9)
    doc.save(folder/'original.pdf');doc.close()
    fields={'title':cn,'aliases':[en],'year':2026,'authors':['Example Research Group'],'human_status':'未读'}
    (folder/'00-论文卡片.md').write_text('---\n'+yaml.safe_dump(fields,allow_unicode=True)+'---\n\nSynthetic demo only.\n')
    (folder/'metadata.json').write_text(json.dumps({'title':en,'chinese_title':cn,'abstract':'Synthetic demo document for interface exploration. No scientific claims.','authors':['Example Research Group']},ensure_ascii=False))
print(root)
