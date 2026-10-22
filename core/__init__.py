"""Analysis core: no web framework imports.

FastAPI and the MCP server both call these functions.
"""

from core.coverage import check_coverage
from core.burn import classify_burn
from core.seismic import check_seismic_confound
from core.pwtt import screen_for_change
from core.bundle import get_evidence_bundle

__all__ = [
    "check_coverage",
    "classify_burn",
    "check_seismic_confound",
    "screen_for_change",
    "get_evidence_bundle",
]
