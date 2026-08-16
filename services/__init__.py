# Services package — data loading / caching helpers shared by routes and analysis.
import os
import sys

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in sys.path:
    sys.path.insert(0, _root)
import vendor_libs
vendor_libs.setup(_root)
_broker = os.path.join(_root, "broker")
if _broker not in sys.path:
    sys.path.insert(0, _broker)
