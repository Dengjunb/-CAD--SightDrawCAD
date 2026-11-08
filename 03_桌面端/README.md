> 本文件是上级 `01_桌面应用/README.md` 的副本。本目录只保留重打包所需的 Electron 侧文件（main.js / preload.js / package.json / 图标）；
> 不含 node_modules 与 backend 二进制，需先 `npm ci`，并从 `03_软件材料/v3.0_工程源` 构建后端后拷入（见第六节）。

# 桌面应用 · 使用与打包说明（v3.0）

> **界面默认整体白色调**（门户 / 手动 / AI / 草图 / 3D 均为浅色）；手动与 AI 窗口顶栏可切回深色。

## 一、给最终用户（解压即用）

1. 解压得到的 `CAD双模式智能识图_v3.0_桌面版/` 整个目录可直接拷走（U 盘 / 其它电脑）。
2. 双击目录里的 **`CAD双模式智能识图.exe`**。

首次启动会有 3~8 秒「正在启动本地服务…」转圈，这是后端引擎在初始化（numpy / OpenCV 加载较慢），属正常现象。

- 不需要安装 Python，不需要 pip 装任何东西
- 绿色版：整个目录自带 Electron 运行时 + v3.0 引擎（`resources\backend\`）
- 关闭窗口自动退出后端进程，不留残留
- 端口自动分配，不会和本机其他服务冲突

> 本版 exe **内嵌 v3.0 引擎**：参数化草图 / AI 建模 / AI 全自动 3D / AI 模型管理 / 深底反相识别 全部可用，与源码运行功能一致。

## 二、门户工作台（v3.0 两个窗口）

启动后先进入 **门户首页**，只有两张卡片：**手动** 与 **AI**。四项功能都收在窗口里，不用来回找入口：

| 窗口 | 里面有什么 | 怎么切 |
| --- | --- | --- |
| **手动** | 手动绘图（经典 CAD 式绘图：命令行、捕捉、图层、DXF）+ 参数化草图（19 种约束、尺寸驱动、LM 求解与自由度/冲突诊断、AI 建模、命令栈撤销、图元树、DXF R12、打印/PDF）；窗口内可直接开 **AI 助手**抽屉 | 手动工具栏「草图」按钮 → 参数化草图页；草图页「← 手动绘图」回来（带 `?mod=manual`） |
| **AI** | 看图成图（图片 → DXF/SVG，含深底反相 / 纠偏 / 文字保护，AI 对话改参数、解释识图结果）+ AI 全自动 3D（主轮廓 + 孔 → 拉伸 → 3D 预览 → STL/OBJ） | AI 页顶栏「🧩 AI 全自动 3D」→ 3D 页；3D 页「← / AI 制图」回来（带 `?mod=ai`） |

左下角常驻 **⌂ 工作台** 按钮，随时回到门户。`?mod=manual` / `?mod=ai` 可直接深链进对应窗口。

**手动窗口（2026-11-07 新版工作区）**：左侧常驻工具条（绘图 / 修改 / 视图 / AI，图标或带文字两形态，当前命令高亮）；选中后画布顶部浮出「特性 / 移动 / 复制 / 旋转 / 删除 / 缩放到 / 取消选择」；夹点可拖动改形；捕捉标记旁标「端点 / 中点 / 圆心 / 交点…」；双击对象跳到特性页签；**修剪 TR / 延伸 EX**（全部对象作边界）；顶部「功能区 / 面板 / 工具条 / 专注」四个开关，默认已收起功能区与右侧面板，画布最大化；**画布大小自己调**：顶部「画布」→ 铺满/大/中/小 或拖动宽高滑块（40–100%），画布与面板之间的分隔条可拖动调面板宽度。**AI 制图**（创新点）：不用图片，一句话生成零件或改尺寸，如 `法兰 外圆120 内孔60 6个直径10的孔 均布直径100`、`板120x80 四角孔直径10`、`轴 长200 直径40`、`把选中的圆半径改成50`，执行走命令栈可撤销。

**AI 窗口**：另有「✎ AI 制图」按钮——**有图片就走识图**（自动切到看图成图并出 DXF/SVG），**没图片就用一句话自绘**（可导出 DXF / 去手动窗口编辑）。

**颜色 / 背景**：顶部「颜色」支持 ByLayer、16 色调色板、自定义色，「应用到选中」可改已选对象颜色；「背景」一键白色浅色 / 深色，浅底时近白色线自动显示为深灰。

**尺寸标注**：`DIM` 线性标注、`DIAD` 直径标注（导出 DXF 为 LINE + TEXT）；另有齿轮、沉孔等 AI 自绘模板。视图缩放/平移已修复为对图形真实生效。

**草图 ↔ 3D 联动**：参数化草图页顶部「发送到 3D」保存草稿并打开 3D 页；3D 页「从草图导入」按端点串成闭合轮廓后直接拉伸成实体，无需重新识图。

## 三、目录说明

```
01_桌面应用/
├ CAD双模式智能识图_v3.0_桌面版/     ← 双击这里面的 exe 即可运行
│   ├ CAD双模式智能识图.exe          Electron 外壳 + v3.0 引擎
│   ├ ai_config.json                 大模型配置模板（可编辑）
│   ├ README.txt                     终端用户速查
│   └ resources/
│       ├ app.asar                   main.js / 前端壳（Electron 应用包）
│       └ backend/                   v3.0 引擎（CADEngine.exe + image2cad/web）
├ backend/                           免 Electron 引擎（同一构建，可直接命令行运行）
├ ai_config.json                     配置模板（与桌面版目录内的一致）
├ build/                             图标源文件
├ README.md                          本文件
└ 重打包工程源/                      main.js / preload.js / package.json / 图标，重打包用
```

`backend/` 的用途：当 exe 被杀软拦截、或想用浏览器直接访问时，可以

```
01_桌面应用\backend\CADEngine.exe serve --port 8799 --host 127.0.0.1
```

然后在浏览器打开 `http://127.0.0.1:8799/`，得到与桌面版完全一致的 v3.0 界面（无需 Python）。

## 四、AI 能力与 Key 配置

两类 AI 入口，都走本地后端（OpenAI 兼容协议）：

1. 顶部「AI 制图」—— 指令执行，走 `/api/ai/run`。
2. 右下角「AI 助手」抽屉 —— SSE 流式对话，模型可切换 DeepSeek / 通义千问 / 智谱 GLM / 硅基流动。

**配置 Key（必须）**：编辑桌面版目录里的 `ai_config.json`（或界面「⚙ AI 模型设置」里新增/测试/保存）：

```json
{
  "default": "DeepSeek",
  "models": [
    { "name": "DeepSeek", "base": "https://api.deepseek.com", "model": "deepseek-chat", "key": "sk-你的key" }
  ]
}
```

Electron 主进程启动时读取它并注入环境变量；也可设系统环境变量 `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` / `ZHIPU_API_KEY` / `SILICONFLOW_API_KEY`。未配置 Key 时对话返回明确错误，不会静默失败。

自测开关（可选）：设置环境变量 `I2C_AI_MOCK=1` 后启动，AI 不联网返回固定中文（验证链路/演示），正常勿设。

## 五、运行架构

```
CAD双模式智能识图.exe  (Electron 外壳)
   |-- 0. 读 exe 同目录 ai_config.json -> 注入 API Key 环境变量
   |-- 1. 挑选空闲端口 N
   |-- 2. spawn resources\backend\CADEngine.exe serve --port N --host 127.0.0.1
   |-- 3. 轮询 http://127.0.0.1:N/ 直到 200
   |-- 4. BrowserWindow 加载（门户首页 -> 手动 / AI 两个窗口）
   +-- 5. 窗口关闭 -> kill 后端进程
```

后端接口（v3.0 全量）：

```
GET  /                      门户（index.html + portal.js 注入「手动 / AI」两张卡片）
GET  /?mod=manual|ai        深链直达对应窗口
GET  /static/sketch/…       参数化草图（约束求解、AI 建模、DXF）
GET  /static/3d/…           AI 全自动 3D
POST /api/run               识图（图片 → DXF/SVG）
GET  /api/ai/models         模型列表（Key 打码）
POST /api/ai/models/save    保存模型（协议白名单）
POST /api/ai/models/test    测试连通性
POST /api/ai/run            结构化指令
POST /api/ai/chat           SSE 流式对话
```

## 六、开发者：重新打包（v3.0 步骤）

前提：Python 3.10+（本机 3.14）已装 `requirements.txt` 依赖与 PyInstaller；Node 18+。

```bat
:: 0) 回到完整包根目录（本文件所在目录的上一级）
:: 1) 重建后端（v3.0 引擎），产物在 03_软件材料\v3.0_工程源\dist\CADEngine
cd 03_软件材料\v3.0_工程源
py -m PyInstaller --noconfirm --clean CADEngine.spec
cd ..\..

:: 2) 组装桌面应用：后端拷进重打包工程源，再装依赖打包
xcopy "03_软件材料\v3.0_工程源\dist\CADEngine" "01_桌面应用\重打包工程源\backend" /E /I /Y
cd 01_桌面应用\重打包工程源
npm ci

:: 3) 打包（目录版；Electron 28 / electron-builder 26）
node node_modules\electron-builder\cli.js --win dir
:: 产物 dist\win-unpacked\，改名为「CAD双模式智能识图_v3.0_桌面版」后压缩分发
```

说明：

- 本版交付的桌面目录 = `win-unpacked` 改名 + `resources\app` 打成 `app.asar` + `resources\backend` 放入 v3.0 引擎 + `ai_config.json` 放到 exe 同目录。
- 若机器无法联网下载 Electron 运行时，可把 `node_modules\electron\dist` 解压好的运行时（含 `electron.exe`）作为 `electronDist` 传给 electron-builder（`config.electronDist`），即可离线打包。
- `npm install` 前先确认 `node_modules` 已删除（控体积），本目录未附 `node_modules`。

## 七、排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 双击秒退、无窗口 | 宿主环境设置了 `ELECTRON_RUN_AS_NODE` | 本版 main.js 已强制清除；如仍出现，先在干净命令行里去掉该变量再启动 |
| 对话提示未配置 API Key | 未填 key | 配 `ai_config.json` 或环境变量 |
| 门户卡片点了没反应 | 前端缓存旧版 | 强刷（Ctrl+F5）或确认 `resources\backend` 是 v3.0 构建 |
| 对话一直不返回 | 模型不可达 / Key 无效 | 看是否误开 `I2C_AI_MOCK`；看错误气泡 |
| 提示无法启动本地识别服务 | `resources\backend` 缺失或被隔离 | 确认 `resources\backend\CADEngine.exe` 存在并加白名单 |
| 提示未知发布者 | 未签名 | 「更多信息 → 直接运行」 |

## 八、已验证项（v3.0 实机，2026-11-07）

在交付目录内直接启动 `CAD双模式智能识图.exe`，实测：

- 后端自动在随机空闲端口拉起（当次 56670 / 50120），`GET /` 返回 200，安全响应头 `X-Frame-Options: DENY` 生效；
- 门户 2 张卡片（手动 / AI）渲染正常，`?mod=manual|ai` 深链直达；
- 手动窗口：MDraw 画布可见、工具栏「草图」按钮在位、AI 助手抽屉可开且层级在画布之上；
- 手动窗口新版工作区：左侧工具条 15 键在位；工具条「直线」画线后实体 18→19；夹点拖动把线端点 (-10,40) 移到 (20,60)；捕捉标记显示「端点」；双击对象激活特性页签；「功能区」可收起；
- **AI 指令**：`画矩形120x80` 返回「已画矩形：120.00 × 80.00（视图中心）」；`把选中的圆半径改成50` 生效；执行进命令栈可撤销；
- 画布最大化：默认收起功能区与右侧面板（画布 1120×603 → 1416×673），工具条缩为图标（147→65 px），专注模式画布高 745；
- 修剪 / 延伸：横线 0–100 点 x=50 左侧 → 变 0–50；短线 200–220 点右端 → 延伸到 250（仅直线，全部对象作边界）；
- **AI 自绘**：手动窗口 `法兰 外圆120 内孔60 6个直径10的孔 均布直径100` → 8 个圆；AI 窗口「✎ AI 自绘」`板120x80 四角孔直径10` → 矩形 + 4 个角孔，图元计数正常，可导出 DXF；
- AI 窗口：`static/aimodels.js` 25 300 字节，看图成图可跑通（示例/上传 → 6 个下载件），「AI 全自动 3D」按钮在位；
- **AI 制图页不再发虚**：全屏模糊遮罩 1 → 0（页面截图 Laplacian 方差 32 → 2 114）；
- `static/sketch/index.html` 含「发送到 3D」、`static/3d/index.html` 含「从草图导入」——草图→3D 联动可用；
- 截图见 `04_运行截图/v3.0实机渲染/01-门户-两入口.png`、`05-桌面版-AI制图.png`、`06-桌面版-手动窗口-AI制图.png`、`07-桌面版-AI窗口自绘.png`。
