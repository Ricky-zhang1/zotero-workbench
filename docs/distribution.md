# 1.0 便携安装与升级

Releases 的 portable ZIP 包含自有本地 marketplace、插件、官方 Node 24、PDF.js 与许可。解压完整目录，通过 Codex 支持的本地 marketplace 入口安装；不要只取 plugins 子目录，也不要手改缓存。没有该入口的 Codex 版本尚未验证安装路径。

macOS arm64 有真实运行时冷启动和只读连接验证；Windows x64 包仅完成构建/资源校验，未真机验收。请按平台选包。没有外部用户验收，不宣称任何电脑上均已可用。

基础功能不要求安装系统 Node/Python 或外部 Zotero MCP。打开 Zotero 并允许本地通信；Zotero 10 的写入仍需 Zotero 授权。TextFold、证据审计、语义检索是有额外依赖的独立能力，详见 RELEASE-1.0.md。

升级前保存当前工作并完整退出 Codex，安装后重新打开。不要在旧 MCP 进程仍运行时清理旧资源；维护安装器会阻断这种情况。ZIP 内的权限应完整保留；不要靠删库、删操作台账解决升级失败。

开发者：Node24构建源码，Python运行package-portable.py打包；默认只下载官方固定Node发行物并核对校验和，支持--archive/--shasums离线提供已下载的官方档案。基础包不包含PyMuPDF或Python环境。
