"""Loader registry. Each loader implements `iter_records()` and declares its raw-data root."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Iterable

from ..schema import BenchRecord

_REGISTRY: dict[str, type["BaseLoader"]] = {}


def register_loader(name: str):
    def deco(cls: type["BaseLoader"]):
        _REGISTRY[name] = cls
        cls.source_name = name
        return cls
    return deco


def get_loader(name: str, root: Path) -> "BaseLoader":
    return _REGISTRY[name](root=root)


def all_loaders() -> list[str]:
    return sorted(_REGISTRY.keys())


class BaseLoader(ABC):
    source_name: str = "unknown"

    def __init__(self, root: Path):
        self.root = Path(root)

    @abstractmethod
    def iter_records(self) -> Iterable[BenchRecord]:
        ...

    def is_available(self) -> bool:
        """Whether the raw data has been downloaded."""
        return self.root.exists() and any(self.root.iterdir())
