# Services package — data loading / caching helpers shared by routes and analysis.
import sys
import os
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (os.path.join(_root, "libs"), os.path.join(_root, "broker")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
