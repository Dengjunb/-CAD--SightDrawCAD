# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = ['image2cad.cli']
hiddenimports += collect_submodules('titleblock')


a = Analysis(
    ['engine_entry.py'],
    pathex=['.'],
    binaries=[],
    datas=[('image2cad/web', 'image2cad/web'), ('image2cad/ocr_win.ps1', 'image2cad'), ('demo/images', 'demo/images'), ('示例图纸', '示例图纸'), ('titleblock', 'titleblock')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['torch', 'matplotlib', 'pandas', 'scipy', 'onnxruntime', 'llvmlite', 'pyarrow', 'numba', 'IPython', 'tkinter', 'sympy', 'pytest', 'sqlalchemy', 'PyQt5', 'PySide6'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='CADEngine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='CADEngine',
)
