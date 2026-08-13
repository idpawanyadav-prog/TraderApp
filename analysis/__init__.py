# Analysis package — statistical pair-screening modules.
# Self-contained: only requires numpy (vendored in libs/).
import sys
import os
_libs = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "libs")
if _libs not in sys.path:
    sys.path.insert(0, _libs)
