#!/usr/bin/env python3
# 解压 zip 并修复 Windows 下打包的 GBK 中文文件名（需要 Python 3.11+）
import sys, zipfile, os

src, dest = sys.argv[1], sys.argv[2]

def open_zip():
    for enc in ('gbk', 'gb18030', None):
        try:
            z = zipfile.ZipFile(src, metadata_encoding=enc) if enc else zipfile.ZipFile(src)
            z.namelist()
            return z
        except (UnicodeDecodeError, ValueError):
            continue
    return zipfile.ZipFile(src)

with open_zip() as z:
    for info in z.infolist():
        name = info.filename
        target = os.path.normpath(os.path.join(dest, name))
        if not target.startswith(os.path.normpath(dest)):
            continue  # 防路径穿越
        if name.endswith('/'):
            os.makedirs(target, exist_ok=True); continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(info) as fi, open(target, 'wb') as fo:
            fo.write(fi.read())
        print(name)
