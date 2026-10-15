#!/usr/bin/env bash
# 下载多个上游仓库的最新 release，解压出 js 到 sources/<owner>__<repo>/
# 用法: UPSTREAM="a/b,c/d" FORCE=false bash scripts/fetch-upstreams.sh
# 输出: dist/upstream.json（各上游已处理的 tag），GITHUB_OUTPUT 中 changed=true/false
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STATE="$ROOT/dist/upstream.json"
UNZIP="python3 $ROOT/scripts/unzip_gbk.py"
mkdir -p "$ROOT/dist"
[ -f "$STATE" ] || echo '{}' > "$STATE"

rm -rf "$ROOT/sources" && mkdir -p "$ROOT/sources"
NEW_STATE='{}'
CHANGED=false
SUMMARY=""

IFS=',' read -ra REPOS <<< "${UPSTREAM:-guoyue2010/lxmusic-}"
for repo in "${REPOS[@]}"; do
  repo=$(echo "$repo" | xargs)            # 去空格
  [ -z "$repo" ] && continue
  echo "::group::$repo"
  if ! gh api "repos/$repo/releases/latest" > /tmp/release.json 2>/dev/null; then
    echo "⚠️ $repo 获取 release 失败，跳过"; echo "::endgroup::"; continue
  fi
  tag=$(jq -r .tag_name /tmp/release.json)
  last=$(jq -r --arg r "$repo" '.[$r] // "none"' "$STATE")
  echo "最新: $tag  上次: $last"
  [ "$tag" != "$last" ] && CHANGED=true
  NEW_STATE=$(echo "$NEW_STATE" | jq --arg r "$repo" --arg t "$tag" '. + {($r): $t}')
  SUMMARY="$SUMMARY $repo@$tag"

  dl=$(mktemp -d); ex=$(mktemp -d)
  jq -r '.assets[] | [.name, .browser_download_url] | @tsv' /tmp/release.json | while IFS=$'\t' read -r name url; do
    echo "下载 $name"
    curl -fsSL -o "$dl/$name" "$url" || echo "⚠️ 下载失败 $name"
  done
  for f in "$dl"/*; do
    [ -e "$f" ] || continue
    case "${f,,}" in
      *.zip) $UNZIP "$f" "$ex" >/dev/null ;;                       # 修复 GBK 中文文件名
      *.7z|*.rar|*.tar|*.tar.gz|*.tgz) 7z x -y -o"$ex" "$f" >/dev/null ;;
      *.js) cp "$f" "$ex/" ;;
      *) echo "忽略 $(basename "$f")" ;;
    esac
  done
  # 嵌套压缩包再解一层
  find "$ex" -type f -iname '*.zip' -print0 | while IFS= read -r -d '' z; do $UNZIP "$z" "$ex" >/dev/null || true; done
  find "$ex" -type f \( -iname '*.7z' -o -iname '*.rar' \) -exec 7z x -y -o"$ex" {} \; >/dev/null || true

  out="$ROOT/sources/${repo//\//__}"
  mkdir -p "$out"
  find "$ex" -type f -name '*.js' -print0 | while IFS= read -r -d '' f; do cp "$f" "$out/$(basename "$f")"; done
  echo "得到 $(ls "$out" | wc -l) 个 js"
  rm -rf "$dl" "$ex"
  echo "::endgroup::"
done

# 上游列表本身变了（增删仓库）也算变化
if [ "$(jq -S . "$STATE")" != "$(echo "$NEW_STATE" | jq -S .)" ]; then CHANGED=true; fi
[ "${FORCE:-false}" = "true" ] && CHANGED=true

total=$(find "$ROOT/sources" -name '*.js' | wc -l)
echo "共 $total 个 js，changed=$CHANGED"
[ "$total" -gt 0 ] || { echo "没有找到任何 js"; exit 1; }

echo "$NEW_STATE" | jq . > "$STATE"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "changed=$CHANGED" >> "$GITHUB_OUTPUT"
  echo "summary=$SUMMARY" >> "$GITHUB_OUTPUT"
fi
