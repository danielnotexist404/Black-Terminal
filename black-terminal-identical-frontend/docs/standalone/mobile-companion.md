# Mobile companion boundary

Black Terminal's mobile targets are companion clients. They can present local market data, workspaces, alerts, and P2P controls while the app is in the foreground. They are not replacements for the desktop strategy host.

## Why mobile cannot be the unattended host

- iOS may suspend or terminate an app's networking and WebView after it leaves the foreground.
- Android requires a foreground service and persistent notification, and device-vendor battery controls can still terminate it.
- An exchange automation engine must not imply continued protection or take-profit management when the operating system can stop it without a deterministic handoff.

Accordingly, mobile initialization forces background execution off. The desktop host must remain powered, awake, connected, and running for unattended local strategies. Quitting the desktop tray process stops that host.

## Current build outputs

The `Standalone mobile companion` workflow compiles:

- an arm64 Android debug APK for device testing;
- an unsigned arm64 iOS Simulator application for UI/runtime validation.

These are engineering artifacts, not store releases. Android distribution still requires a protected upload keystore and Play Console release. iPhone/iPad installation requires an Apple Distribution identity, registered bundle identifier, provisioning profile, and App Store/TestFlight or authorized ad-hoc delivery.

## Security gate

The desktop credential vault is not silently downgraded on mobile. Broker secrets, the permanent peer identity, and encrypted profile data must use a certified mobile vault integration before a phone/tablet may connect live broker accounts or act as a trusted P2P authority. Until that gate passes, the mobile artifact is for companion UI and simulator/device testing only.
