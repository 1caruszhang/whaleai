/**
 * OS notification service.
 *
 * Front-end's only job here is "should we ask the OS to show a toast right
 * now?" — gating on user focus and throttling. The actual toast rendering and
 * (critically) click handling live in Rust (`notification.rs`), so the
 * `tab_id` deep-link path is structural rather than a JS-side time-window
 * race.
 *
 * Why no `@tauri-apps/plugin-notification` import: that package's
 * `sendNotification` returns void on desktop and never gives us a handle to
 * attach `onclick`, so click activation always silently failed on Windows.
 * The Rust module bypasses the plugin's JS shim and uses
 * `tauri-winrt-notification`'s `Toast::on_activated` directly.
 */

import { invoke } from '@tauri-apps/api/core';

import type {
    GeoNotificationLocator,
    GeoNotificationResolution,
} from '../../shared/geo/notification';
import type { NotificationClickPayload } from '@/utils/notificationClickRoute';
import { isTauriEnvironment } from '../utils/browserMock';


/**
 * Tell Rust the window has just been activated externally — flushes any
 * pending click target the front-end didn't yet receive (covers macOS / Linux
 * where the OS auto-activates the app on toast click but no in-process
 * Activated callback fires).
 */
export async function consumePendingNotificationClick(): Promise<boolean> {
    if (!isTauriEnvironment()) return false;
    try {
        return await invoke<boolean>('cmd_consume_notification_click');
    } catch (error) {
        console.warn('[Notification] cmd_consume_notification_click failed:', error);
        return false;
    }
}

/** Installs the cold-start barrier and atomically consumes at most one exact click. */
export async function notificationClickListenerReady(): Promise<NotificationClickPayload | null> {
    if (!isTauriEnvironment()) return null;
    return invoke<NotificationClickPayload | null>('cmd_notification_click_listener_ready');
}

/** Revalidates every locator component against the Rust-owned workspace store. */
export async function resolveGeoNotificationLocator(
    locator: GeoNotificationLocator,
): Promise<GeoNotificationResolution> {
    return invoke<GeoNotificationResolution>('cmd_resolve_geo_notification_locator', { locator });
}

/**
 * Initialize notification service.
 *
 * Permission flow is intentionally absent: desktop OS notifications under
 * `tauri-plugin-notification` and the WinRT path don't require a runtime
 * permission grant — macOS / Linux rely on system-level settings,
 * Windows uses AUMID via NSIS shortcut. Anything we'd do here would just be
 * theatre.
 */
