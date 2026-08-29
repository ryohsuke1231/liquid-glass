import glob, html, os
from weasyprint import HTML

files = sorted(glob.glob("src/**/*.ts", recursive=True)) + [
    "extension.js",
    "prefs.js",
    "shaders/glass.frag",
]

all_pages = []
first_doc = None

for filepath in files:
    if os.path.exists(filepath):
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            code = html.escape(f.read())
        
        # CSS文字列用にパスのエスケープ処理
        safe_filepath = filepath.replace("\\", "\\\\").replace('"', '\\"')

        file_html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@font-face {{
    font-family: 'CustomJetBrains';
    src: url('file:///usr/share/fonts/truetype/jetbrains-mono/JetBrainsMonoNL-Regular.ttf');
}}
@page {{
    size: A4;
    margin: 12mm 15mm 15mm 15mm;
    
    @top-left {{
        content: "{safe_filepath}";
        font-family: 'CustomJetBrains', 'Noto Sans CJK JP', monospace;
        font-size: 6pt;
        border-bottom: 1px solid black;
        padding-bottom: 4px;
        vertical-align: bottom;
        width: 50%;
        margin-bottom: 0.8em;
    }}
    @top-right {{
        /* 各ファイルごとの現在ページ / 総ページ数が標準で正確に計算されます */
        content: "Page " counter(page) " / " counter(pages);
        font-family: 'CustomJetBrains', 'Noto Sans CJK JP', monospace;
        font-size: 6pt;
        border-bottom: 1px solid black;
        padding-bottom: 4px;
        vertical-align: bottom;
        width: 50%;
        text-align: right;
        margin-bottom: 0.8em;
    }}
}}
body {{
    font-family: 'CustomJetBrains', 'Noto Sans CJK JP', monospace;
    font-size: 6pt;
}}
pre {{
    margin: 0;
    font-family: inherit;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-all;
}}
</style>
</head>
<body>
<pre>{code}</pre>
</body>
</html>"""

        # ファイル単位でドキュメントを生成
        doc = HTML(string=file_html).render()
        if first_doc is None:
            first_doc = doc
        all_pages.extend(doc.pages)

# 生成された全ページを1つのPDFにまとめて出力
if first_doc and all_pages:
    first_doc.copy(all_pages).write_pdf("output.pdf")
    print("完了: output.pdf が作成されました")
else:
    print("対象ファイルが見つかりませんでした")
