"""Load ./libs like site-packages, including pywin32.

pip install --target=libs does not run .pth files. Without that, vendored
pywin32 cannot load pythoncom*.dll and Excel looks 'not open'. A copied
libs folder that omits pywin32 accidentally falls back to Anaconda and works.
"""
from __future__ import annotations

import glob
import os
import shutil
import sys

def setup(root=None):
    if root is None:
        root = os.path.dirname(os.path.abspath(__file__))
    libs = os.path.join(root, "libs")
    if not os.path.isdir(libs):
        return libs
    try:
        import site
        site.addsitedir(libs)
    except Exception:
        if libs not in sys.path:
            sys.path.append(libs)
    if sys.platform == "win32":
        _win32_dll_dirs(libs)
    return libs


def finish_install(root=None):
    """Copy pywin32 DLLs next to win32/*.pyd after pip --target=libs."""
    if sys.platform != "win32":
        return
    if root is None:
        root = os.path.dirname(os.path.abspath(__file__))
    libs = os.path.join(root, "libs")
    src = os.path.join(libs, "pywin32_system32")
    if not os.path.isdir(src):
        return
    dests = [
        os.path.join(libs, "win32"),
        libs,
    ]
    for dest in dests:
        if not os.path.isdir(dest):
            continue
        for dll in glob.glob(os.path.join(src, "*.dll")):
            shutil.copy2(dll, os.path.join(dest, os.path.basename(dll)))
    setup(root)


def _win32_dll_dirs(libs):
    dirs = [
        os.path.join(libs, "pywin32_system32"),
        os.path.join(libs, "win32"),
        os.path.join(libs, "win32", "lib"),
    ]
    path_parts = os.environ.get("PATH", "").split(os.pathsep)
    for d in dirs:
        if not os.path.isdir(d):
            continue
        if d not in path_parts:
            path_parts.insert(0, d)
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(d)
            except OSError:
                pass
    os.environ["PATH"] = os.pathsep.join(path_parts)
