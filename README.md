# 识绘 CAD v3.0 · 软件架构目录

> 识绘 CAD v3.0（曾用名：CAD 双模式智能识图）
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
    ├─ assemble.ps1               组装脚本
    ├─ 01_桌面壳/                 卷1 82.6 MB / 卷2 95.0 MB / 卷3 73.6 MB
    ├─ 02_前端资源/               app.asar + ai_config.json（<1 MB）
    ├─ 03_引擎程序/               CADEngine.exe（10.5 MB）
    └─ 04_引擎依赖/               卷1 18.1 MB / 卷2 82.3 MB / 卷3 86.0 MB
```
