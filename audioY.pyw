"""Double-click target. Starts audioY with no console window."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audioy.__main__ import main

sys.exit(main())
