import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

// Panic corner fail-safe
func checkPanicCorner(x: CGFloat, y: CGFloat) {
    if x <= 5 && y <= 5 {
        fputs("{\"error\":\"Panic corner triggered at (0, 0): automated input aborted\"}\n", stderr)
        exit(2)
    }
}

func getScreenInfo() -> (width: CGFloat, height: CGFloat, scale: CGFloat) {
    let screen = NSScreen.main ?? NSScreen.screens.first!
    return (screen.frame.width, screen.frame.height, screen.backingScaleFactor)
}

func getCursor() -> (x: CGFloat, y: CGFloat) {
    let mouseLoc = NSEvent.mouseLocation
    let screen = NSScreen.main ?? NSScreen.screens.first!
    let quartzY = screen.frame.height - mouseLoc.y
    return (mouseLoc.x, quartzY)
}

func outputJSON(_ object: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("{}")
    }
}

let args = CommandLine.arguments

guard args.count > 1 else {
    print("""
    Usage: macos-input-helper <command> [args...]
      state
      move <x> <y>
      click <x> <y> [button: left|right|middle] [count: 1..3]
      drag <x1> <y1> <x2> <y2> [button: left|right]
      scroll <x> <y> <dx> <dy>
      type <text>
      key <keyName> [modifier1,modifier2...]
      windows
      focus <appName>
    """)
    exit(1)
}

let command = args[1]

switch command {
case "state":
    let (w, h, s) = getScreenInfo()
    let (cx, cy) = getCursor()
    let isTrusted = AXIsProcessTrusted()
    let result: [String: Any] = [
        "accessibility": isTrusted,
        "cursor": ["x": cx, "y": cy],
        "screen": ["width": w, "height": h, "scale": s]
    ]
    outputJSON(result)

case "move":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
        fputs("Usage: move <x> <y>\n", stderr); exit(1)
    }
    let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
    checkPanicCorner(x: pt.x, y: pt.y)
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)
    event?.post(tap: .cghidEventTap)
    outputJSON(["success": true, "action": "move", "x": x, "y": y])

case "click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
        fputs("Usage: click <x> <y> [button] [count]\n", stderr); exit(1)
    }
    let buttonStr = args.count > 4 ? args[4].lowercased() : "left"
    let count = args.count > 5 ? (Int(args[5]) ?? 1) : 1
    let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
    checkPanicCorner(x: pt.x, y: pt.y)

    // First move to target point
    let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)
    moveEvent?.post(tap: .cghidEventTap)
    usleep(20_000) // 20ms settle

    let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = {
        switch buttonStr {
        case "right":
            return (.rightMouseDown, .rightMouseUp, .right)
        case "middle":
            return (.otherMouseDown, .otherMouseUp, .center)
        default:
            return (.leftMouseDown, .leftMouseUp, .left)
        }
    }()

    for i in 1...count {
        let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: pt, mouseButton: cgButton)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down?.post(tap: .cghidEventTap)
        usleep(15_000)

        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: pt, mouseButton: cgButton)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up?.post(tap: .cghidEventTap)
        usleep(25_000)
    }

    outputJSON(["success": true, "action": "click", "x": x, "y": y, "button": buttonStr, "count": count])

case "drag":
    guard args.count >= 6,
          let x1 = Double(args[2]), let y1 = Double(args[3]),
          let x2 = Double(args[4]), let y2 = Double(args[5]) else {
        fputs("Usage: drag <x1> <y1> <x2> <y2> [button]\n", stderr); exit(1)
    }
    let p1 = CGPoint(x: CGFloat(x1), y: CGFloat(y1))
    let p2 = CGPoint(x: CGFloat(x2), y: CGFloat(y2))
    checkPanicCorner(x: p1.x, y: p1.y)
    checkPanicCorner(x: p2.x, y: p2.y)

    // Move to start
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p1, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(20_000)
    // Mouse down
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p1, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    usleep(30_000)

    // Interpolate drag
    let steps = 15
    for i in 1...steps {
        let progress = CGFloat(i) / CGFloat(steps)
        let curX = p1.x + (p2.x - p1.x) * progress
        let curY = p1.y + (p2.y - p1.y) * progress
        let dragPt = CGPoint(x: curX, y: curY)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: dragPt, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(10_000)
    }

    // Mouse up
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p2, mouseButton: .left)
    up?.post(tap: .cghidEventTap)

    outputJSON(["success": true, "action": "drag", "from": ["x": x1, "y": y1], "to": ["x": x2, "y": y2]])

case "scroll":
    guard args.count >= 6,
          let x = Double(args[2]), let y = Double(args[3]),
          let dx = Int32(args[4]), let dy = Int32(args[5]) else {
        fputs("Usage: scroll <x> <y> <dx> <dy>\n", stderr); exit(1)
    }
    let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
    checkPanicCorner(x: pt.x, y: pt.y)

    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(10_000)

    let scrollEvent = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    scrollEvent?.post(tap: .cghidEventTap)

    outputJSON(["success": true, "action": "scroll", "x": x, "y": y, "dx": dx, "dy": dy])

case "type":
    guard args.count >= 3 else {
        fputs("Usage: type <text>\n", stderr); exit(1)
    }
    let text = args[2]

    for char in text {
        let str = String(char)
        var utf16 = Array(str.utf16)

        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        down?.post(tap: .cghidEventTap)
        usleep(5_000)

        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up?.post(tap: .cghidEventTap)
        usleep(10_000)
    }

    outputJSON(["success": true, "action": "type", "length": text.count])

case "key":
    guard args.count >= 3 else {
        fputs("Usage: key <keyName> [modifiers]\n", stderr); exit(1)
    }
    let keyName = args[2].lowercased()
    let modsStr = args.count > 3 ? args[3].lowercased() : ""

    let keyMap: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49,
        "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
        "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
        "w": 13, "x": 7, "y": 16, "z": 6,
        "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29
    ]

    guard let keyCode = keyMap[keyName] else {
        fputs("Unknown key: \(keyName)\n", stderr)
        exit(1)
    }

    var flags: CGEventFlags = []
    if modsStr.contains("cmd") || modsStr.contains("command") { flags.insert(.maskCommand) }
    if modsStr.contains("shift") { flags.insert(.maskShift) }
    if modsStr.contains("alt") || modsStr.contains("option") { flags.insert(.maskAlternate) }
    if modsStr.contains("ctrl") || modsStr.contains("control") { flags.insert(.maskControl) }

    let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    usleep(20_000)

    let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)

    outputJSON(["success": true, "action": "key", "key": keyName, "modifiers": modsStr])

case "windows":
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let infoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        outputJSON([])
        exit(0)
    }

    var list: [[String: Any]] = []
    for item in infoList {
        let layer = item[kCGWindowLayer as String] as? Int ?? 0
        if layer == 0 {
            let owner = item[kCGWindowOwnerName as String] as? String ?? ""
            let title = item[kCGWindowName as String] as? String ?? ""
            let id = item[kCGWindowNumber as String] as? Int ?? 0
            if !owner.isEmpty {
                var entry: [String: Any] = ["id": id, "app": owner, "title": title]
                if let bounds = item[kCGWindowBounds as String] as? [String: Any] {
                    entry["bounds"] = bounds
                }
                list.append(entry)
            }
        }
    }
    outputJSON(list)

case "focus":
    guard args.count >= 3 else {
        fputs("Usage: focus <appName>\n", stderr); exit(1)
    }
    let target = args[2].lowercased()
    let apps = NSWorkspace.shared.runningApplications
    if let match = apps.first(where: { ($0.localizedName ?? "").lowercased().contains(target) }) {
        match.activate()
        outputJSON(["success": true, "focused": match.localizedName ?? target])
    } else {
        outputJSON(["success": false, "error": "Application not found: \(target)"])
    }

default:
    fputs("Unknown command: \(command)\n", stderr)
    exit(1)
}
