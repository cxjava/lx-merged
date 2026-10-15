#!/usr/bin/env bash
# 压缩合集：uglifyjs 去掉所有注释，再把合集自己的头注释（落雪靠它识别 @name 等）放回最前面
# 用法: bash scripts/minify.sh dist/lx-merged.js dist/lx-merged.min.js
set -euo pipefail
src=$1; out=$2
tmp=$(mktemp)
npx -y uglify-js@3 --compress --mangle -o "$tmp" "$src"
node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const m=s.match(/^\/\*![\s\S]*?\*\//);process.stdout.write(m?m[0]+"\n":"")' "$src" > "$out"
cat "$tmp" >> "$out"
rm -f "$tmp"
echo "压缩: $(wc -c < "$src") -> $(wc -c < "$out") 字节"
