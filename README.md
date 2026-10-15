# 落雪音源聚合

自动同步上游仓库（默认 [guoyue2010/lxmusic-](https://github.com/guoyue2010/lxmusic-)，可配置多个）的最新 release，逐个测试音源，把可用的合并成一个文件。

## 使用

首次：仓库 **Settings → Pages → Source** 选择 **GitHub Actions**，然后在 Actions 页手动运行一次。

在落雪 / 支持 LX 自定义源的 APP 中导入（推荐压缩版）：

```
https://<你的用户名>.github.io/<仓库名>/lx-merged.min.js
https://<你的用户名>.github.io/<仓库名>/lx-merged.js
```

测试报告：`https://<你的用户名>.github.io/<仓库名>/`

## 流程（`.github/workflows/update.yml`）

1. 每 24 小时（或手动）运行 `scripts/fetch-upstreams.sh`：下载 `UPSTREAM`（逗号分隔）中每个仓库的最新 release，解压 zip / 7z / rar 到 `sources/<owner>__<repo>/`（修复 GBK 中文文件名）
2. `scripts/test-sources.js`：用各平台官方搜索接口搜歌（默认“晴天 周杰伦”），再让每个音源取播放链接，并检查链接是否可访问
3. `scripts/build.js`：只合并测试通过的；同名只保留最高版本；每个音源只处理它通过的平台；通过平台多的优先
4. `scripts/minify.sh`：uglifyjs 压缩生成 `lx-merged.min.js`（保留头注释）
5. `scripts/verify-merged.js`：测试完整版和压缩版，全部失败则不发布
6. `scripts/make-pages.js` 生成首页，`dist/` 整体发布到 GitHub Pages（不向仓库提交任何文件）

参数可在手动运行时填写，或在仓库 Settings → Secrets and variables → Actions → Variables 设置同名变量：`UPSTREAM`、`RACE_CONCURRENCY`、`TIMEOUT_MS`、`DEFAULT_QUALITY`、`EXCLUDE_OBFUSCATED`、`TOP_PER_PLATFORM`、`DEDUP_THRESHOLD`

## 本地运行

```bash
UPSTREAM="guoyue2010/lxmusic-" bash scripts/fetch-upstreams.sh   # macOS 需 bash 4+
node scripts/test-sources.js sources dist/report.json
node scripts/build.js sources dist/report.json dist/lx-merged.js
bash scripts/minify.sh dist/lx-merged.js dist/lx-merged.min.js
node scripts/verify-merged.js dist/lx-merged.min.js
```
