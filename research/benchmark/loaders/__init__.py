"""Per-source loaders. Each loader yields BenchRecord objects."""

from .base import BaseLoader, register_loader, get_loader, all_loaders

__all__ = ["BaseLoader", "register_loader", "get_loader", "all_loaders"]

# Side-effect imports register loaders.
from . import injecagent  # noqa: F401
from . import agentdojo  # noqa: F401
from . import toolemu  # noqa: F401
from . import owasp  # noqa: F401
from . import toolbench  # noqa: F401
from . import sharegpt  # noqa: F401
from . import aegis_self  # noqa: F401
