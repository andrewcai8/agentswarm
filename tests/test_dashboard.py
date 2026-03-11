import importlib
import importlib.util
import sys
import types
import unittest


def _install_rich_stubs() -> None:
    rich = types.ModuleType("rich")
    rich_console = types.ModuleType("rich.console")
    rich_layout = types.ModuleType("rich.layout")
    rich_live = types.ModuleType("rich.live")
    rich_panel = types.ModuleType("rich.panel")
    rich_table = types.ModuleType("rich.table")
    rich_text = types.ModuleType("rich.text")

    class _Dummy:
        def __init__(self, *args, **kwargs):
            pass

    class _DummyText:
        @classmethod
        def from_markup(cls, *_args, **_kwargs):
            return cls()

        def stylize(self, *_args, **_kwargs):
            return None

    setattr(rich_console, "Console", _Dummy)
    setattr(rich_layout, "Layout", _Dummy)
    setattr(rich_live, "Live", _Dummy)
    setattr(rich_panel, "Panel", _Dummy)
    setattr(rich_table, "Table", _Dummy)
    setattr(rich_text, "Text", _DummyText)

    sys.modules.setdefault("rich", rich)
    sys.modules["rich.console"] = rich_console
    sys.modules["rich.layout"] = rich_layout
    sys.modules["rich.live"] = rich_live
    sys.modules["rich.panel"] = rich_panel
    sys.modules["rich.table"] = rich_table
    sys.modules["rich.text"] = rich_text


def _load_dashboard_module():
    if importlib.util.find_spec("rich") is None:
        _install_rich_stubs()
        sys.modules.pop("dashboard", None)
        return importlib.import_module("dashboard")

    try:
        return importlib.import_module("dashboard")
    except SystemExit:
        _install_rich_stubs()
        sys.modules.pop("dashboard", None)
        return importlib.import_module("dashboard")


class DashboardUtilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dashboard = _load_dashboard_module()

    def test_fmt_tokens(self):
        self.assertEqual(self.dashboard._fmt_tokens(999), "999")
        self.assertEqual(self.dashboard._fmt_tokens(12_345), "12.3K")
        self.assertEqual(self.dashboard._fmt_tokens(2_500_000), "2.5M")

    def test_elapsed_str(self):
        self.assertEqual(self.dashboard._elapsed_str(3661), "01:01:01")

    def test_grid_pane_from_mouse(self):
        self.assertIsNone(self.dashboard._grid_pane_from_mouse(10, 5, 120, 40))
        self.assertEqual(self.dashboard._grid_pane_from_mouse(50, 5, 120, 40), "in_progress")
        self.assertEqual(self.dashboard._grid_pane_from_mouse(90, 5, 120, 40), "completed")


if __name__ == "__main__":
    unittest.main()
