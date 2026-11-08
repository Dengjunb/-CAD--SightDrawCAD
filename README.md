# CAD 双模式智能识图 v3.0 · 软件架构目录

> 本目录只放**软件本体**（前端 / 后端 / 桌面端 / 可运行程序），不含截图、文档、示例素材。
> 直接运行：双击 `04_运行程序/启动-组装并运行.bat`，脚本还原运行目录并启动。

---

## 1. 目录结构

```
CAD双模式智能识图_v3.0/
├─ README.md                     ← 本文件（软件架构 + 运行/构建）
├─ 01_前端应用/                  ← Web 前端（原生 JS，无框架）
│   └─ web/
│       ├─ index.html            门户页（手动 / AI 两入口）
│       ├─ app.js                AI 窗口逻辑（看图成图 / AI 3D / 模型管理）
│       ├─ aimodels.js           AI 模型配置管理
│       ├─ portal.js             门户与窗口路由（两窗口 + 内置 3D 预览）
│       ├─ portal.css            全站样式（白色调默认）
│       ├─ styles.css            AI 窗口样式
│       ├─ mdraw.js              ★ 手动绘图工作区（命令行/工具条/图层/捕捉/标注/块/表格/填充/布局/DXF）
│       ├─ sketch/               参数化草图页（约束求解、尺寸联动、DXF/PDF）
│       └─ 3d/                   AI 3D 页（Canvas 渲染器、STL/OBJ 导出、视图预设、ViewCube）
├─ 02_后端引擎/                  ← Python 本地服务（标准库 + numpy/OpenCV/ezdxf）
│   ├─ image2cad/
│   │   ├─ server.py             HTTP 服务（/、/static、/api/*，端口自动分配）
│   │   ├─ pipeline.py           识图流水线（栅格化→清洗→矢量化→DXF）
│   │   ├─ recognition.py        识别入口/结果结构
│   │   ├─ vectorize.py          轮廓/直线/圆/弧矢量化
│   │   ├─ imaging.py            图像预处理（二值化、反相、去噪）
│   │   ├─ rasterize.py          图片/PDF 栅格化
│   │   ├─ cadclean.py           图元清理/去重/合并
│   │   ├─ dxf_writer.py         DXF 写出（R12 兼容、图层/颜色/文字）
│   │   ├─ manual.py             手动绘图后端辅助（导出/测量）
│   │   ├─ mode_a.py             模式 A（识图）流程编排
│   │   ├─ ai.py                 AI 模型调用（OpenAI 兼容，可配 Key）
│   │   ├─ ocr.py / ocr_win.ps1  Windows OCR
│   │   ├─ config.py             配置读取（ai_config.json / 环境变量）
│   │   ├─ cli.py                命令行入口
│   │   ├─ report.py             识别报告/统计
│   │   └─ models.py             数据模型
│   ├─ engine_entry.py           后端入口（PyInstaller 打包入口）
│   ├─ requirements.txt          Python 依赖
│   ├─ CADEngine.spec            PyInstaller 打包配置（onedir，含 web 资源）
│   ├─ tests/                    后端测试
│   └─ tools/                    辅助脚本
├─ 03_桌面端/                    ← Electron 壳（Windows）
│   ├─ main.js                   主进程：拉起后端、创建窗口、端口注入
│   ├─ preload.js                预加载脚本
│   ├─ package.json              应用元信息
│   └─ README.md                 打包说明
└─ 04_运行程序/                  ← 可运行成品，按架构分卷（每卷 ≤ 95 MB）
    ├─ 00_说明.md                 分卷说明
    ├─ 拆分清单.json              分卷元数据
    ├─ 启动-组装并运行.bat        双击：还原运行目录并启动
    ├─ assemble.ps1               组装脚本（分卷复制 + exe 合并）
    ├─ 01_桌面壳/                 卷1 95.0 / 卷2 90.2 / 卷3 66.1 MB
    ├─ 02_前端资源/               resources/app.asar + ai_config.json（<1 MB）
    ├─ 03_引擎程序/               resources/backend/CADEngine.exe（10.5 MB）
    └─ 04_引擎依赖/               卷1 18.1 / 卷2 82.3 / 卷3 86.0 MB（_internal）
```

## 2. 运行时架构

```
Electron 主进程 (main.js)
   ├─ 启动 resources/backend/CADEngine.exe serve --port <随机>
   ├─ 打开窗口 http://127.0.0.1:<端口>/
   └─ 前端由后端静态托管（/static/*）
         ├─ 门户 index.html（两入口：手动 / AI）
         ├─ 手动工作区 mdraw.js
         ├─ AI 窗口 app.js（识图 / AI 3D / 模型管理）
         ├─ 草图 sketch/（参数化约束 + 求解）
         └─ 3D 3d/（Canvas 网格渲染、STL/OBJ）
用户数据：草稿存 localStorage；AI 配置存 ai_config.json
```

## 3. 运行

1. 打开 `04_运行程序/`
2. 双击 `启动-组装并运行.bat`（首次约 10–30 秒，还原 ~450 MB 到 `运行目录/`）
3. 程序自动启动

> 不安装 Python/Node、不联网；端口自动分配。
> 只组装不启动：`powershell -ExecutionPolicy Bypass -File .\assemble.ps1 -NoLaunch`

## 4. 构建（开发者）

**后端（PyInstaller）**
```bat
cd 02_后端引擎
py -m PyInstaller --noconfirm --clean CADEngine.spec
:: 产物 dist\CADEngine → 复制到 desktop/resources/backend
```

**桌面端（Electron）**
```bat
cd 03_桌面端
npm install
:: 按 README 组装 app.asar 与 backend
```

## 5. 能力索引

| 能力 | 入口 | 代码位置 |
| --- | --- | --- |
| AI 制图（说一句话出零件） | 手动窗口「AI 制图」 | mdraw.js `aiDraw/aiApply` |
| 看图成图（识图转 DXF） | 门户「AI」→ 看图成图 | app.js + pipeline/vectorize/dxf_writer |
| AI 全自动 3D | AI 窗口「AI 全自动 3D」 | 3d/ + ai 轮廓 |
| 参数化草图 | 手动窗口「草图」 | sketch/ + 后端求解接口 |
| 标注/块/表格/填充/布局 | 手动窗口菜单/工具条 | mdraw.js |
| DXF 导出 | 文件菜单/工具条 | mdraw.js `exportDXF` |
| 打印/PDF | 文件菜单 | mdraw.js 布局 + window.print |

## 6. 版本

- 版本：v3.0（2026-11-08）
- 引擎：Python 3.14 + numpy / OpenCV / ezdxf
- 桌面壳：Electron 28.3.3（Windows x64）
