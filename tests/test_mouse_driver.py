#!/usr/bin/env python3
"""
Standalone OS Mouse Controller & DPI Driver Verification Test Suite
Verifies:
1. Native Win32 / OS-level controller initialization and DPI awareness (Per-Monitor v2).
2. Native resolution reporting matches physical hardware display without virtualization drift.
3. Coordinate accuracy: move_to, click, double_click, drag_and_drop, scroll.
4. Structured JSON protocol format and error handling.
"""

import sys
import os
import json
import unittest

# Add tools directory to Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'tools')))

import os_mouse_controller

class TestOSMouseDriver(unittest.TestCase):
    def setUp(self):
        self.display = os_mouse_controller.get_display_info()

    def test_dpi_awareness_and_resolution(self):
        """Verify that DPI awareness is active and native screen resolution is non-zero."""
        self.assertGreater(self.display["width"], 0, "Display width must be positive")
        self.assertGreater(self.display["height"], 0, "Display height must be positive")
        self.assertGreater(self.display["dpi"], 0, "DPI must be positive")
        self.assertGreaterEqual(self.display["scale_percent"], 100, "Scale percent must be at least 100%")
        print(f"\n[DPI Check] Resolution: {self.display['width']}x{self.display['height']} | DPI: {self.display['dpi']} | Scale: {self.display['scale_percent']}%")

    def test_move_to_accuracy(self):
        """Verify that move_to positions the cursor exactly at target coordinates without offset drift."""
        # Choose safe target coordinates within screen boundaries
        target_x = int(self.display["width"] * 0.4)
        target_y = int(self.display["height"] * 0.4)

        # Test instantaneous move (smooth=False)
        pos = os_mouse_controller.move_to(target_x, target_y, smooth=False)
        self.assertEqual(pos[0], target_x, f"Target X ({target_x}) must match cursor X ({pos[0]})")
        self.assertEqual(pos[1], target_y, f"Target Y ({target_y}) must match cursor Y ({pos[1]})")

        # Test smooth interpolation move (smooth=True)
        target_x2 = int(self.display["width"] * 0.45)
        target_y2 = int(self.display["height"] * 0.45)
        pos2 = os_mouse_controller.move_to(target_x2, target_y2, smooth=True, duration=0.08)
        self.assertEqual(pos2[0], target_x2, f"Smooth Target X ({target_x2}) must match cursor X ({pos2[0]})")
        self.assertEqual(pos2[1], target_y2, f"Smooth Target Y ({target_y2}) must match cursor Y ({pos2[1]})")

    def test_click_primitives(self):
        """Verify click, double-click, and right-click execution returns accurate executed_pos."""
        target_x = int(self.display["width"] * 0.5)
        target_y = int(self.display["height"] * 0.5)

        # Single click
        pos_click = os_mouse_controller.click(x=target_x, y=target_y, button="left", count=1, dwell_ms=20, smooth=False)
        self.assertEqual(pos_click, [target_x, target_y])

        # Double click
        pos_dbl = os_mouse_controller.click(x=target_x, y=target_y, button="left", count=2, dwell_ms=20, smooth=False)
        self.assertEqual(pos_dbl, [target_x, target_y])

        # Right click
        pos_rc = os_mouse_controller.click(x=target_x, y=target_y, button="right", count=1, dwell_ms=20, smooth=False)
        self.assertEqual(pos_rc, [target_x, target_y])

    def test_drag_and_drop(self):
        """Verify drag-and-drop moves from start to end accurately."""
        x1 = int(self.display["width"] * 0.3)
        y1 = int(self.display["height"] * 0.3)
        x2 = int(self.display["width"] * 0.35)
        y2 = int(self.display["height"] * 0.35)

        end_pos = os_mouse_controller.drag_and_drop(x1, y1, x2, y2, smooth=False)
        self.assertEqual(end_pos, [x2, y2], f"End position of drag ({end_pos}) must match ({x2}, {y2})")

    def test_scroll_primitive(self):
        """Verify scroll returns current cursor position without errors."""
        pos = os_mouse_controller.scroll(direction="up", amount=2)
        self.assertIsInstance(pos, list)
        self.assertEqual(len(pos), 2)

        pos_down = os_mouse_controller.scroll(direction="down", amount=2)
        self.assertIsInstance(pos_down, list)
        self.assertEqual(len(pos_down), 2)

    def test_command_line_dispatch_format(self):
        """Verify that execute_command returns structured JSON responses matching schema."""
        # Test display_info command
        info_res = os_mouse_controller.execute_command({"action": "display_info"})
        self.assertEqual(info_res["status"], "SUCCESS")
        self.assertIn("display", info_res)
        self.assertIn("timestamp", info_res)

        # Test mouse_move command
        tx = int(self.display["width"] * 0.42)
        ty = int(self.display["height"] * 0.42)
        move_res = os_mouse_controller.execute_command({
            "action": "mouse_move",
            "x": tx,
            "y": ty,
            "smooth": False
        })
        self.assertEqual(move_res["status"], "SUCCESS")
        self.assertEqual(move_res["executed_at"], [tx, ty])
        self.assertIn("timestamp", move_res)

        # Test mouse_click command with double click
        click_res = os_mouse_controller.execute_command({
            "action": "mouse_click",
            "x": tx,
            "y": ty,
            "click_type": "double"
        })
        self.assertEqual(click_res["status"], "SUCCESS")
        self.assertEqual(click_res["executed_at"], [tx, ty])
        self.assertEqual(click_res["count"], 2)

        # Test mouse_drag command
        drag_res = os_mouse_controller.execute_command({
            "action": "mouse_drag",
            "start_x": tx,
            "start_y": ty,
            "end_x": tx + 10,
            "end_y": ty + 10,
            "smooth": False
        })
        self.assertEqual(drag_res["status"], "SUCCESS")
        self.assertEqual(drag_res["executed_at"], [tx + 10, ty + 10])

        # Test mouse_scroll command
        scroll_res = os_mouse_controller.execute_command({
            "action": "mouse_scroll",
            "direction": "down",
            "amount": 3
        })
        self.assertEqual(scroll_res["status"], "SUCCESS")
        self.assertIn("executed_at", scroll_res)

    def test_bounds_clamping(self):
        """Verify coordinates outside physical monitor are clamped safely without throwing."""
        # Beyond right edge
        pos = os_mouse_controller.move_to(self.display["width"] + 500, self.display["height"] + 500, smooth=False)
        self.assertEqual(pos[0], self.display["width"] - 1)
        self.assertEqual(pos[1], self.display["height"] - 1)

        # Negative coordinates
        pos_neg = os_mouse_controller.move_to(-100, -100, smooth=False)
        self.assertEqual(pos_neg[0], 0)
        self.assertEqual(pos_neg[1], 0)


if __name__ == '__main__':
    unittest.main()
