#!/usr/bin/env python3
"""Build a deterministic gzip path/type/size manifest without reading file contents."""
from __future__ import annotations
import argparse,gzip,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--tree',choices=['repo','old'],required=True);ap.add_argument('--output',required=True);a=ap.parse_args()
 root=(ROOT/a.tree).resolve();out=(ROOT/a.output).resolve()
 if ROOT not in root.parents or not root.is_dir() or ROOT not in out.parents:ap.error('tree/output must be inside workspace and tree must exist')
 entries=[]
 for current,dirs,files in os.walk(root,followlinks=False):
  here=Path(current)
  names=list(dirs)+list(files)
  for name in names:
   p=here/name
   rel=p.relative_to(ROOT).as_posix()
   try:
    if p.is_symlink(): kind,size='SYMLINK','-'
    elif p.is_dir(): kind,size='DIR','-'
    elif p.is_file(): kind,size='FILE',str(p.stat().st_size)
    else: kind,size='OTHER','-'
   except OSError: kind,size='UNREADABLE','-'
   entries.append((rel,kind,size))
  dirs[:]=sorted([d for d in dirs if not (here/d).is_symlink()],key=str.casefold)
 entries.sort(key=lambda x:x[0].casefold())
 out.parent.mkdir(parents=True,exist_ok=True)
 with out.open('wb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as gz:
  gz.write(b'# PATH\tTYPE\tSIZE_BYTES\n')
  for rel,kind,size in entries:gz.write(f'{rel}\t{kind}\t{size}\n'.encode('utf-8','surrogateescape'))
 counts={}
 for _,kind,_ in entries:counts[kind]=counts.get(kind,0)+1
 print(f'wrote {out.relative_to(ROOT)} records={len(entries)} types={counts}')
if __name__=='__main__':main()
