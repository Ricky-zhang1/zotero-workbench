#!/usr/bin/env python3
"""
Zotero Better BibTeX API 搜索工具
用于从 Zotero 文献库搜索文献并生成 Lattics 可识别的引用卡片格式

Lattics 引用卡片正确格式：
"引用原文" ([作者, 年份, p. 页码](zotero://select/library/items/{key}))
"""

import json
import sys
import urllib.request
import urllib.error

# Better BibTeX JSON-RPC 端点
BBT_API_URL = "http://localhost:23119/better-bibtex/json-rpc"


def search_items(query: str) -> list[dict]:
    """
    搜索 Zotero 文献库

    Args:
        query: 搜索关键词（标题、作者、年份等）

    Returns:
        匹配的文献列表，每项包含 id, title, author, year, citation-key 等
    """
    payload = {
        "jsonrpc": "2.0",
        "method": "item.search",
        "params": [query],
        "id": 1
    }

    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            BBT_API_URL,
            data=data,
            headers={"Content-Type": "application/json"}
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result.get("result", [])

    except urllib.error.URLError as e:
        print(f"错误: 无法连接到 Better BibTeX API ({BBT_API_URL})", file=sys.stderr)
        print(f"请确保 Zotero 正在运行且 Better BibTeX 插件已启用", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"错误: API 返回格式无效", file=sys.stderr)
        sys.exit(1)


def extract_item_key(item_id: str) -> str:
    """
    从完整 URI 中提取 item_key

    Args:
        item_id: 如 "http://zotero.org/users/10821588/items/LT4NEJPX"

    Returns:
        item_key: 如 "LT4NEJPX"
    """
    return item_id.split("/")[-1]


def format_author(item: dict) -> str:
    """
    格式化作者姓名

    Args:
        item: 文献信息字典

    Returns:
        格式化的作者字符串
    """
    authors = item.get("author", [])
    if not authors:
        return "未知作者"

    if len(authors) == 1:
        return authors[0].get("literal", authors[0].get("family", ""))
    elif len(authors) == 2:
        return f"{authors[0].get('literal', '')}和{authors[1].get('literal', '')}"
    else:
        return f"{authors[0].get('literal', '')}等"


def format_year(item: dict) -> str:
    """
    提取年份

    Args:
        item: 文献信息字典

    Returns:
        年份字符串
    """
    issued = item.get("issued", {})
    if issued and "date-parts" in issued:
        date_parts = issued["date-parts"]
        if date_parts and len(date_parts) > 0 and date_parts[0]:
            return str(date_parts[0][0])
    return ""


def format_card(item: dict, context: str = None, excerpt: str = None, page: str = None, pdf_key: str = None, pdf_page: str = None, annotation_id: str = None) -> str:
    """
    格式化为 Lattics 引用卡片格式

    正确格式：
    正文 "引用原文" ([作者, 年份, p. 页码](zotero链接)) ([pdf](zotero://open-pdf/...))

    Args:
        item: 文献信息字典
        context: 正文/上下文（用户的论述）
        excerpt: 引用文本/摘录
        page: 可选页码
        pdf_key: PDF 的 item_key（可选）
        pdf_page: PDF 页码（可选，默认与 page 相同）
        annotation_id: PDF 标注 ID（可选）

    Returns:
        Lattics 引用卡片格式字符串
    """
    item_key = extract_item_key(item.get("id", ""))
    author_str = format_author(item)
    year = format_year(item)
    title = item.get("title", "")

    # 构建引用链接部分
    if page:
        cite_text = f"{author_str}, {year}, p. {page}"
    else:
        cite_text = f"{author_str}, {year}"

    link = f"([{cite_text}](zotero://select/library/items/{item_key}))"

    # 构建 PDF 链接部分（如果提供了 pdf_key）
    pdf_link = ""
    if pdf_key:
        pdf_page_num = pdf_page or page or "1"
        if annotation_id:
            pdf_link = f" ([pdf](zotero://open-pdf/library/items/{pdf_key}?page={pdf_page_num}&annotation={annotation_id}))"
        else:
            pdf_link = f" ([pdf](zotero://open-pdf/library/items/{pdf_key}?page={pdf_page_num}))"

    # 如果没有提供摘录，使用标题作为引用文本
    if not excerpt:
        excerpt = f"参见{title[:50]}{'...' if len(title) > 50 else ''}"

    # Lattics 正确格式：正文 "引用原文" ([作者](链接)) ([pdf](pdf链接))
    # 引用原文必须用双引号包裹
    if context:
        return f'{context} "{excerpt}" {link}{pdf_link}'
    else:
        return f'"{excerpt}" {link}{pdf_link}'


def format_citation(item: dict, page: str = None) -> str:
    """
    格式化为简单引用格式（仅引用链接）

    Args:
        item: 文献信息字典
        page: 可选页码

    Returns:
        Lattics 格式引用字符串
    """
    item_key = extract_item_key(item.get("id", ""))
    author_str = format_author(item)
    year = format_year(item)

    if page:
        cite_text = f"{author_str}, {year}, p. {page}"
    else:
        cite_text = f"{author_str}, {year}"

    return f"([{cite_text}](zotero://select/library/items/{item_key}))"


def main():
    """命令行入口"""
    import argparse

    parser = argparse.ArgumentParser(
        description="Zotero 文献搜索与 Lattics 引用卡片生成",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 基础搜索
  python3 zotero_search.py "教育生产函数"

  # 带页码引用
  python3 zotero_search.py "李波黄斌" --page 155

  # 生成完整引用卡片
  python3 zotero_search.py "巨型学校" --context "万明钢等的研究指出..." --excerpt "盲目追求规模效益..." --page 35

  # 输出原始 JSON
  python3 zotero_search.py "城镇化" --format json
        """
    )

    parser.add_argument("query", help="搜索关键词")
    parser.add_argument("--page", "-p", help="页码", default=None)
    parser.add_argument("--excerpt", "-e", help="引用文本/摘录", default=None)
    parser.add_argument("--context", "-c", help="正文/上下文", default=None)
    parser.add_argument("--pdf-key", help="PDF 的 item_key（从 Zotero 链接复制）", default=None)
    parser.add_argument("--pdf-page", help="PDF 页码（默认与 page 相同）", default=None)
    parser.add_argument("--annotation", "-a", help="PDF 标注 ID", default=None)
    parser.add_argument("--format", "-f",
                        choices=["card", "citation", "json", "key"],
                        default="card", help="输出格式 (默认: card)")
    parser.add_argument("--limit", "-l", type=int, default=5, help="返回结果数量限制")

    args = parser.parse_args()

    items = search_items(args.query)

    if not items:
        print(f"未找到匹配 '{args.query}' 的文献", file=sys.stderr)
        sys.exit(0)

    # 限制结果数量
    items = items[:args.limit]

    if args.format == "json":
        print(json.dumps(items, ensure_ascii=False, indent=2))
    elif args.format == "key":
        for item in items:
            print(extract_item_key(item.get("id", "")))
    elif args.format == "citation":
        for item in items:
            print(format_citation(item, args.page))
            print(f"  标题: {item.get('title', 'N/A')}")
            print()
    else:  # card
        for i, item in enumerate(items, 1):
            card = format_card(item, args.context, args.excerpt, args.page, args.pdf_key, args.pdf_page, args.annotation)
            print(f"--- 结果 {i} ---")
            print(card)
            print(f"\n文献: {item.get('title', 'N/A')}")
            print(f"作者: {format_author(item)}, 年份: {format_year(item)}")
            print()


if __name__ == "__main__":
    main()
