# Analysis package — statistical pair-screening modules.
# Self-contained: only requires numpy (vendored in libs/).
import os
import sys

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in sys.path:
    sys.path.insert(0, _root)
import vendor_libs
vendor_libs.setup(_root)
