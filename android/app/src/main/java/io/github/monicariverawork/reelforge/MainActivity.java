package io.github.monicariverawork.reelforge;

import com.getcapacitor.BridgeActivity;

/**
 * Hosts the web editor in Capacitor's WebView bridge.
 *
 * ReelForge has no native editing screen today: plugins, lifecycle and the JavaScript
 * bridge are configured by Capacitor, while React owns routing and application state.
 */
public class MainActivity extends BridgeActivity {}
