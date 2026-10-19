# ReadVocab

一个本地优先的英文论文阅读、取词和生词记录工具。上传 PDF，双击取词，释义和原句自动进入生词本，统计页记录每天积累了多少词。

## 功能

- PDF 连续阅读，按需渲染，支持缩放和阅读进度记忆
- 双击取词 / 拖选短语，弹出音标、词性、中文释义、英文释义、原文语境和发音
- 本地 ECDICT 词库，约 77 万词条，完全离线查询
- 词形归一：`study` / `studies` / `studied` 只记为一个词
- 生词本：搜索、状态筛选（新词 / 学习中 / 已掌握）、多语境保留、发音
- 统计：累计收录、今日新增、连续天数、本周查阅、年度热力图、按文档分布
- 整句翻译：免费使用 MyMemory，无需 API key；选中整句或点“免费翻译本句”即可
- 可选调用 DeepSeek，获得更准确的 AI 查词和翻译
- 深色模式，数据全部保存在本机

## 技术栈

- 后端：FastAPI + SQLite
- 前端：原生 ES Modules，无构建步骤
- PDF：pdf.js 4.10（已内置在 `static/vendor/pdfjs`，Apache-2.0）
- 词典：ECDICT
- 免费翻译：MyMemory
- 可选 LLM：DeepSeek（OpenAI 兼容接口）

## 快速开始

### 1. 安装依赖

```bash
python -m pip install -r requirements.txt
```

需要 Python 3.10 及以上版本。

### 2. 导入词典

```bash
python importer.py
```

脚本会按以下顺序查找 ECDICT CSV：

1. 命令行传入的路径
2. 环境变量 `ECDICT_CSV`
3. `data/ecdict.csv`
4. `C:\dev\downloads\ecdict.csv`

都没有时会自动下载到 `data/ecdict.csv`。导入完成后生成约 115 MB 的 `data/readvocab.db`，只需执行一次。

手动指定路径：

```bash
python importer.py D:\path\to\ecdict.csv
```

### 3. 免费翻译（可选配置）

整句翻译默认使用 MyMemory，不需要 API key。匿名使用每天有约 5000 字符的额度；在 `.env` 中填写 `MYMEMORY_EMAIL` 可以提高到约 50000 字符/天。

```
MYMEMORY_EMAIL=you@example.com
```

使用免费翻译时，选中的文本会发送到 MyMemory。

### 4. 配置 LLM（可选）

复制 `.env.example` 为 `.env`，填入 DeepSeek key：

```
DEEPSEEK_API_KEY=sk-...
```

不填也能使用本地查词、免费翻译、生词本和统计，只是无法使用 AI 查词和 AI 翻译。

### 5. 启动

```bash
python -X utf8 app.py
```

Windows 下也可以直接双击 `start.bat`，然后打开 <http://127.0.0.1:8000>。

## 使用

1. 拖入一个文本型 PDF（扫描版没有文本层，无法取词）
2. 双击单词查看释义；点卡片里的“免费翻译本句”可以直接翻译所在句
3. 拖选一整个句子，在弹卡里点“免费翻译”或“AI 翻译”
4. 在“生词本”里搜索、修改学习状态
5. 在“统计”里查看每日新增和连续天数

## 数据说明

- `data/` 和 `.env` 已加入 `.gitignore`，不会提交到仓库
- 数据库、PDF 和生词记录只存在本机
- 使用免费翻译或 AI 翻译时，选中文本会发送到对应的外部服务
- 请勿把填了 API key 的 `.env` 提交到公开仓库

## 目录结构

```
readvocab/
  app.py          FastAPI 后端
  db.py           SQLite schema
  importer.py     ECDICT 导入
  llm.py          DeepSeek 客户端
  config.py       .env 读取与配置
  static/         前端（原生 JS + pdf.js）
  data/           运行时数据，不提交
```

## 已知限制

- 扫描版 PDF 没有文本层，无法取词
- 双栏论文的“原句”偶尔可能串到相邻栏
- 目前只支持 PDF，不支持其他格式
