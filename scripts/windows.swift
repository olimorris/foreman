// Usage: windows.swift check | windows.swift <pid>
// Prints whether this process may capture the screen, or the on-screen window ids of <pid>, largest first.
import CoreGraphics
import Foundation

let args = CommandLine.arguments.dropFirst()
if args.first == "check" {
    print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")
    exit(0)
}
guard let pid = args.first.flatMap(Int32.init) else {
    FileHandle.standardError.write("usage: windows.swift check | <pid>\n".data(using: .utf8)!)
    exit(2)
}
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let windows = info.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
let sized = windows.compactMap { w -> (Int, Double)? in
    guard let id = w[kCGWindowNumber as String] as? Int,
          let b = w[kCGWindowBounds as String] as? [String: Double] else { return nil }
    return (id, (b["Width"] ?? 0) * (b["Height"] ?? 0))
}
for (id, _) in sized.sorted(by: { $0.1 > $1.1 }) { print(id) }
