import AppKit
import CoreGraphics
import Foundation

// Presentation only: never hides the user's cursor or synthesizes input.
final class ActivityView: NSView {
    var point = CGPoint.zero
    var owner = "Thread unavailable"
    var detail = "Using computer"
    var pulse: CGFloat = 0
    let accent = NSColor.systemCyan
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let c = NSGraphicsContext.current?.cgContext else { return }
        c.saveGState()
        // One real pointer, with a soft halo centered on its actual hotspot.
        let radius: CGFloat = 17 + 2 * sin(pulse)
        c.setFillColor(accent.withAlphaComponent(0.10).cgColor)
        c.setStrokeColor(accent.withAlphaComponent(0.85).cgColor)
        c.setLineWidth(2)
        c.addEllipse(in: CGRect(x: point.x-radius, y: point.y-radius, width: radius*2, height: radius*2))
        c.drawPath(using: .fillStroke)

        let width: CGFloat = min(320, bounds.width - 24)
        let height: CGFloat = 62
        // Flip the badge around the pointer near display edges.
        let x = max(12, min(point.x + 28, bounds.width - width - 12))
        let y = max(12, min(point.y + 22, bounds.height - height - 12))
        let rect = CGRect(x: x, y: y, width: width, height: height)
        c.setShadow(offset: CGSize(width: 0, height: 2), blur: 12, color: NSColor.black.withAlphaComponent(0.3).cgColor)
        c.setFillColor(NSColor(calibratedWhite: 0.08, alpha: 0.96).cgColor)
        c.addPath(CGPath(roundedRect: rect, cornerWidth: 14, cornerHeight: 14, transform: nil))
        c.fillPath()
        c.setShadow(offset: .zero, blur: 0)
        c.setFillColor(accent.cgColor)
        c.fillEllipse(in: CGRect(x: x+13, y: y+14, width: 7, height: 7))
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let titleAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.white, .paragraphStyle: paragraph]
        let detailAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.lightGray, .paragraphStyle: paragraph]
        ("COMPUTER USE · " + detail as NSString).draw(in: CGRect(x: x+27, y: y+10, width: width-39, height: 18), withAttributes: titleAttrs)
        (owner as NSString).draw(in: CGRect(x: x+13, y: y+34, width: width-26, height: 18), withAttributes: detailAttrs)
        c.restoreGState()
    }
}

final class Overlay: NSObject, NSApplicationDelegate {
    var panels: [(NSPanel, ActivityView, NSScreen)] = []
    var tick: Timer?
    var deadline = Date.distantPast
    var visible = false
    var explicitAction = false
    var owner = "Thread unavailable"
    var detail = "Using computer"

    func applicationDidFinishLaunching(_ notification: Notification) {
        for screen in NSScreen.screens {
            let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .statusBar
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
            let view = ActivityView(frame: NSRect(origin: .zero, size: screen.frame.size))
            panel.contentView = view
            panel.alphaValue = 0
            panels.append((panel, view, screen))
        }
        tick = Timer.scheduledTimer(withTimeInterval: 1.0/60, repeats: true) { [weak self] _ in self?.update() }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // readLine buffers fragmented IPC messages correctly.
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.command(json) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func command(_ json: [String: Any]) {
        let action = json["action"] as? String ?? ""
        if action == "exit" || action == "quit" { NSApp.terminate(nil); return }
        if action == "end" || action == "hide" {
            explicitAction = false
            deadline = Date()
            return
        }
        if let name = json["threadTitle"] as? String, !name.isEmpty { owner = String(name.prefix(180)) }
        else if let id = json["threadId"] as? String, !id.isEmpty { owner = "Thread " + String(id.prefix(100)) }
        else { owner = "Thread unavailable" }
        detail = String((json["status"] as? String ?? "Using computer").prefix(80))
        explicitAction = action == "begin"
        // Watchdog for a dead/disconnected client; legacy clients get short idle fade.
        let seconds = explicitAction ? 15.0 : min(5, max(0.8, (json["duration"] as? Double ?? 0) + 0.8))
        deadline = Date().addingTimeInterval(seconds)
        visible = true
    }

    func update() {
        let remaining = deadline.timeIntervalSinceNow
        let alpha = remaining > 0 ? 1.0 : max(0, 1 + remaining / 0.35)
        let location = NSEvent.mouseLocation // global AppKit logical points, bottom-left origin
        for (panel, view, screen) in panels {
            let inside = screen.frame.contains(location)
            panel.alphaValue = inside && visible ? alpha : 0
            if inside && visible && alpha > 0 {
                view.point = CGPoint(x: location.x-screen.frame.minX, y: screen.frame.maxY-location.y)
                view.owner = owner
                view.detail = detail
                view.pulse = CGFloat(Date().timeIntervalSinceReferenceDate * 4)
                panel.orderFrontRegardless()
                view.needsDisplay = true
            } else if alpha == 0 { panel.orderOut(nil) }
        }
        if alpha == 0 { visible = false }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Overlay()
app.delegate = delegate
app.run()
