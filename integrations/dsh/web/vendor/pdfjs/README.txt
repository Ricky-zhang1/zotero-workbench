pdf.js 兜底构建（仅当宿主未提供 /zotero-workbench/pdfjs/build/ 时使用）
====================================================================

版本：pdfjs-dist@6.3.289
来源：npm（`npm pack pdfjs-dist@6.3.289`，包内 build/pdf.min.mjs 与 build/pdf.worker.min.mjs）
许可：Apache-2.0（原始许可证见同目录 LICENSE，版权归 Mozilla Foundation 及贡献者）

为什么这里有一份构建：
- 任务契约要求宿主通过 /zotero-workbench/pdfjs/build/pdf.mjs 与 pdf.worker.mjs 提供
  pdf.js；但仓库 dist/pdfjs/ 目前只有 cmaps/、standard_fonts/、wasm/，没有 build/
  （上游把 pdf.js 内联进了 dist/ui/panel.html，没有独立 ESM 构建可复用）。
- 应用加载顺序：
    1) 主路径  /zotero-workbench/pdfjs/build/pdf.mjs（动态 import；宿主补齐后自动使用）
    2) 兜底    /zotero-workbench/app/vendor/pdfjs/pdf.min.mjs（本目录，Blob URL import）
  worker 与主模块同源同目录切换，不会出现「主模块 A + worker B」的版本混用。
- 版本对齐：dist/pdfjs/ 中 cmaps/、standard_fonts/、wasm/ 的资源与 pdfjs-dist@6.3.289
  完全一致（已核对 jbig2.wasm、LiberationSans-Regular.ttf 的 SHA-256），因此三种资源
  统一从 /zotero-workbench/pdfjs/{cmaps,standard_fonts,wasm}/ 加载是正确的。
- 若 Lead 之后把 pdfjs-dist 的 build/pdf.mjs 与 build/pdf.worker.mjs 放进
  dist/pdfjs/build/，本目录可以整体删除（主路径会优先生效，但保留也无害）。

注意：
- 本目录是应用静态资源的一部分，会经 /zotero-workbench/app/vendor/pdfjs/ 被服务；
  不是 npm 依赖，不参与任何构建步骤。
- 文件名中的 .min 表示上游 minified 构建；内容同 Apache-2.0 许可的 pdf.js 发行物。
