import Capacitor
import UIKit

// "Block screenshots". iOS has no public API for it. The render server leaves a layer out of
// screenshots, recordings and mirroring when its disableUpdateMask holds the bits UIKit gives a
// secure text field, so Bramble reads those bits off one and sets them on the window's layer.
// See docs/screen-capture-blocking.md.
enum ScreenCapture {
	private static let pref = "CapacitorStorage.meta:pref.screenCaptureBlocked"
	private static let maskKey = "disableUpdateMask"

	// This launch only, so a restart ends a pause.
	private static var chosen: Bool?
	private static var pauseEnds = Date.distantPast
	private static var pauseEnd: DispatchWorkItem?
	private(set) static var blocking = false

	/// The bits on this iOS, or 0 where CALayer lacks the property or secure text isn't hidden
	/// this way.
	private static let secureBits: Int = {
		guard CALayer.instancesRespond(to: NSSelectorFromString("setDisableUpdateMask:")) else { return 0 }
		let field = UITextField()
		field.isSecureTextEntry = true
		return firstMask(in: field.layer)
	}()

	/// Main thread only. The bits came off a secure field, and they land on and lift off a spare
	/// layer without touching its other bits.
	static let available: Bool = {
		guard secureBits != 0 else { return false }
		let probe = CALayer()
		set(probe, true)
		guard mask(of: probe) == secureBits else { return false }
		set(probe, false)
		return mask(of: probe) == 0
	}()

	/// Only a stored `false` allows capture, so a missing or unreadable value blocks.
	static func blockedBy(_ stored: String?) -> Bool {
		stored?.trimmingCharacters(in: .whitespacesAndNewlines) != "false"
	}

	/// When the current pause ends, or nil when there is none.
	static var pausedUntil: Date? { pauseEnds > Date() ? pauseEnds : nil }

	static func apply(to window: UIWindow?) {
		guard available, let window else { return }
		let on = (chosen ?? blockedBy(UserDefaults.standard.string(forKey: pref))) && pausedUntil == nil
		set(window.layer, on)
		blocking = on
	}

	static func choose(_ blocked: Bool, window: UIWindow?) {
		chosen = blocked
		pauseEnds = .distantPast
		pauseEnd?.cancel()
		apply(to: window)
	}

	/// Allow capture for `seconds`. The deadline is checked again on every return to the foreground,
	/// since the timer doesn't run while the app is suspended.
	static func pause(_ seconds: TimeInterval, window: UIWindow?) -> Date {
		pauseEnds = Date().addingTimeInterval(seconds)
		apply(to: window)
		pauseEnd?.cancel()
		let end = DispatchWorkItem { [weak window] in apply(to: window) }
		pauseEnd = end
		DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: end)
		return pauseEnds
	}

	private static func set(_ layer: CALayer, _ on: Bool) {
		let bits = mask(of: layer)
		layer.setValue(on ? bits | secureBits : bits & ~secureBits, forKey: maskKey)
	}

	private static func mask(of layer: CALayer) -> Int {
		(layer.value(forKey: maskKey) as? NSNumber)?.intValue ?? 0
	}

	private static func firstMask(in layer: CALayer) -> Int {
		let own = mask(of: layer)
		if own != 0 { return own }
		return (layer.sublayers ?? []).lazy.map(firstMask).first { $0 != 0 } ?? 0
	}
}

@objc(ScreenCapturePlugin)
public class ScreenCapturePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "ScreenCapturePlugin"
	public let jsName = "ScreenCapture"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "setBlocked", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "pausedUntil", returnType: CAPPluginReturnPromise),
	]

	override public func load() {
		NotificationCenter.default.addObserver(
			self, selector: #selector(screenshotTaken),
			name: UIApplication.userDidTakeScreenshotNotification, object: nil)
	}

	@objc private func screenshotTaken() {
		if ScreenCapture.blocking { notifyListeners("blockedScreenshot", data: [:]) }
	}

	private var window: UIWindow? { bridge?.viewController?.view.window }

	private static func ms(_ date: Date?) -> Double {
		date.map { ($0.timeIntervalSince1970 * 1000).rounded() } ?? 0
	}

	@objc func available(_ call: CAPPluginCall) {
		DispatchQueue.main.async { call.resolve(["available": ScreenCapture.available]) }
	}

	@objc func setBlocked(_ call: CAPPluginCall) {
		guard let blocked = call.getBool("blocked") else { return call.reject("blocked is required") }
		DispatchQueue.main.async {
			ScreenCapture.choose(blocked, window: self.window)
			call.resolve()
		}
	}

	@objc func pause(_ call: CAPPluginCall) {
		let ms = call.getDouble("ms") ?? 0
		guard ms > 0 else { return call.reject("ms is required") }
		DispatchQueue.main.async {
			let until = ScreenCapture.pause(ms / 1000, window: self.window)
			call.resolve(["until": Self.ms(until)])
		}
	}

	@objc func pausedUntil(_ call: CAPPluginCall) {
		DispatchQueue.main.async { call.resolve(["until": Self.ms(ScreenCapture.pausedUntil)]) }
	}
}
